"""The system part of a test's PATH, with no program of a name the tools could reach for real.

A test's PATH is its stand-ins' directory, then this: one directory of links to every program in /usr/bin, /bin,
/usr/sbin and /sbin except HIDDEN. So a tool under test reaches only the test's stand-ins, never a real syns, bb,
claude or gh of the host (GitHub's runner keeps docker, gh, curl and others in /usr/bin), and a stand-in a test leaves
out is missing wherever the test runs. A test that needs a real program by name passes it as `keep`
(`test-release-tools` keeps git, for repositories on local paths only).

    PATH = stand_ins + os.pathsep + syspath.system_path()

The directory is made once per process and `keep`, under a temp folder removed at exit.
"""

import atexit
import os
import shutil
import tempfile

SYSTEM_DIRS = ("/usr/bin", "/bin", "/usr/sbin", "/sbin")
# Every program a tool here calls or could reach the network with, by name: a tool's new program goes here too.
HIDDEN = ("agent-browser", "bb", "claude", "curl", "docker", "gh", "git", "node", "npm", "npx", "nc", "ncat", "rsync",
          "scp", "ssh", "syns", "wget", "yq")
# Made at import, before a test points tempfile or TMPDIR at a scratch folder it removes.
_ROOT = tempfile.mkdtemp(prefix="verify-syspath.")
atexit.register(shutil.rmtree, _ROOT, True)
_MADE = {}


def system_path(*keep):
    """A directory of links to the system programs but HIDDEN (less `keep`), the first of each name in SYSTEM_DIRS."""
    key = tuple(sorted(keep))
    if key in _MADE:
        return _MADE[key]
    d = os.path.join(_ROOT, "sys-" + "-".join(key) if key else "sys")
    os.mkdir(d)
    hidden = set(HIDDEN) - set(keep)
    for sysdir in SYSTEM_DIRS:
        try:
            names = os.listdir(sysdir)
        except OSError:
            continue
        for name in names:
            src, dst = os.path.join(sysdir, name), os.path.join(d, name)
            if name in hidden or os.path.lexists(dst) or not os.path.isfile(src) or not os.access(src, os.X_OK):
                continue
            os.symlink(src, dst)
    _MADE[key] = d
    return d
