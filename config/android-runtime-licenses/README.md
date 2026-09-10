Android runtime notices
=======================

The build also copies the copyright/LICENSE files from the SHA256-locked Termux
packages (Node.js, c-ares, ICU and zlib) into APK assets/host-licenses. Node's
copyright file includes notices for its bundled third-party dependencies.

Termux libc++ 29 is copied from Google Android NDK r29; its package recipe is:
https://github.com/termux/termux-packages/blob/master/packages/libc%2B%2B/build.sh

The LLVM licenses are preserved from the following upstream tagged files:
- https://github.com/llvm/llvm-project/blob/llvmorg-21.1.0/libcxx/LICENSE.TXT
- https://github.com/llvm/llvm-project/blob/llvmorg-8.0.0/libcxx/LICENSE.TXT

No Termux APK, package manager, install scripts or remote code loader is run.
The exact runtime package versions, download paths, archive SHA256 values and
extracted file SHA256 values are in config/android-runtime.lock.json.
