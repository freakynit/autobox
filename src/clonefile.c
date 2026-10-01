/* Batched, strict macOS file cloning. Input: NUL-separated source/destination pairs. */
#include <sys/clonefile.h>
#include <copyfile.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "lock")) {
    int fd = open(argv[2], O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB) != 0) {
      fprintf(stderr, "workspace lock: %s\n", strerror(errno));
      if (fd >= 0) close(fd);
      return 1;
    }
    printf("locked\n");
    fflush(stdout);
    // Closing the parent's pipe (including on a crash) releases the OS lock.
    while (getchar() != EOF) {}
    close(fd);
    return 0;
  }
  if (argc != 2 || (strcmp(argv[1], "clone") && strcmp(argv[1], "auto"))) return 2;
  char *src = NULL, *dst = NULL;
  size_t sc = 0, dc = 0, cloned = 0, copied = 0;
  ssize_t sn, dn;
  while ((sn = getdelim(&src, &sc, '\0', stdin)) != -1) {
    dn = getdelim(&dst, &dc, '\0', stdin);
    if (sn < 2 || src[sn - 1] != '\0' || dn < 2 || dst[dn - 1] != '\0') return 2;
    if (clonefile(src, dst, CLONE_NOFOLLOW | CLONE_ACL) == 0) {
      cloned++;
    } else {
      int clone_errno = errno;
      if (strcmp(argv[1], "auto") ||
          (clone_errno != EXDEV && clone_errno != ENOTSUP && clone_errno != ENOSYS && clone_errno != EINVAL)) {
        fprintf(stderr, "clone %s: %s\n", src, strerror(clone_errno));
        return 1;
      }
      if (copyfile(src, dst, NULL, COPYFILE_ALL | COPYFILE_NOFOLLOW | COPYFILE_EXCL) != 0) {
        fprintf(stderr, "copy %s: %s\n", src, strerror(errno));
        return 1;
      }
      copied++;
    }
  }
  if (ferror(stdin)) return 1;
  free(src);
  free(dst);
  printf("%zu %zu\n", cloned, copied);
  return 0;
}
