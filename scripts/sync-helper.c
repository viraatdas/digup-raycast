// DigUp Messages Sync: runs the export (node sync.js) as a child, so macOS's Full Disk Access granted to this one
// binary covers it (a child's file access is checked against its responsible process), not to node in general.
#include <limits.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;

int main(void) {
    char self[PATH_MAX], dir[PATH_MAX], script[PATH_MAX];
    uint32_t size = sizeof self;
    if (_NSGetExecutablePath(self, &size) != 0) return 1;
    strlcpy(dir, dirname(self), sizeof dir);
    snprintf(script, sizeof script, "%s/sync.js", dir);
    char *argv[] = {NODE_PATH, script, NULL};
    pid_t child;
    if (posix_spawn(&child, NODE_PATH, NULL, NULL, argv, environ) != 0) { perror("posix_spawn"); return 1; }
    int status = 0;
    waitpid(child, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
