# Maintainer: scubba
#
# ewe-apps — ewe Files, ewe Player and ewe Viewer: the first-party apps of the
# ewe desktop (one repo, one package, three Tauri 2 binaries). Tauri v2 has no
# pacman bundler, so this PKGBUILD is how it is packaged for Arch, exactly like
# ewe-sync, Komble and ewe-settings. No privileged helper: everything the apps
# touch is the user's.

pkgname=ewe-apps
# The git TAG and the pacman pkgver are different strings and always
# will be: a tag may carry -beta, an Arch pkgver may not contain a
# hyphen. Of the legal spellings only 0.1.0beta sorts BELOW the
# eventual 0.1.0 under vercmp. The archive is addressed by the TAG and
# extracts to <repo>-<tag without the leading v>, so the source URL and
# the directory below follow _tag, never pkgver. The release workflow
# rewrites both.
_tag=v0.2.0-beta
pkgver=0.2.0beta
pkgrel=1
pkgdesc="ewe Files, ewe Player and ewe Viewer — files, video + music, documents + pictures on the ewe desktop"
arch=('x86_64' 'aarch64')
url="https://github.com/prj786/ewe-apps"
license=('GPL-3.0-only')

depends=(
  'webkit2gtk-4.1'
  'gtk3'
  # <video> / <audio> in WebKitGTK play through GStreamer: every codec once
  # gst-libav is in, hardware decoding through VA-API
  'gst-plugins-base'
  'gst-plugins-good'
  'gst-plugins-bad'
  'gst-plugins-ugly'
  'gst-libav'
  'gst-plugin-va'
  # ewe Player plays the video on a web page (YouTube, Twitch, news sites…): yt-dlp
  # finds the stream (it pulls yt-dlp-ejs + deno, which YouTube's challenge needs)
  'yt-dlp'
  'ffmpegthumbnailer'       # video thumbnails into the freedesktop cache
  'libheif'                 # heif-dec: iPhone HEIC/HEIF pictures (WebKitGTK has no HEIF
                            # decoder) and AVIF thumbnails; djxl comes with libjxl and
                            # libjpeg-turbo / libpng (its JPEG/PNG writers) with webkit2gtk
  'libarchive'              # bsdtar: list / extract / compress archives
  '7zip'                    # 7z archives
)
optdepends=(
  'ewe: the desktop these are the apps of (theme-tokens.json, ewe-conf)'
  'mpv: "Open in mpv" when ewe Player cannot stream a site'
  'plocate: "Search everywhere" in ewe Files'
  'unarchiver: RAR archives bsdtar cannot open (unar, lsar)'
)
makedepends=('rust' 'cargo' 'nodejs' 'npm')

# Arch's makepkg LTO breaks linking some crates' assembly (see Komble's
# PKGBUILD for the full story); Rust-level LTO stays on in Cargo.toml.
options=(!lto !debug)

source=("$pkgname-$pkgver.tar.gz::$url/archive/refs/tags/$_tag.tar.gz")
sha256sums=('SKIP')

build() {
  cd "$srcdir/$pkgname-${_tag#v}"
  # pnpm through npx (the repo is a pnpm workspace); the version is pinned so
  # the lockfile is read the same way everywhere
  npx -y pnpm@11.13.0 install --frozen-lockfile
  # Through the Tauri CLI, never bare `cargo build`: tauri-build decides
  # dev-vs-production at compile time and a plain cargo build bakes the vite
  # devUrl into the binary. --no-bundle: this PKGBUILD is the packaging.
  for app in files player viewer; do
    (cd "apps/$app" && npx -y pnpm@11.13.0 tauri build --no-bundle)
  done
}

package() {
  cd "$srcdir/$pkgname-${_tag#v}"

  for bin in ewe-files-app ewe-player ewe-viewer; do
    install -Dm755 "target/release/$bin" "$pkgdir/usr/bin/$bin"
    install -Dm644 "packaging/$bin.desktop" "$pkgdir/usr/share/applications/$bin.desktop"
    for s in 32 48 64 128 256 512; do
      install -Dm644 "packaging/icons/hicolor/${s}x${s}/apps/$bin.png" \
        "$pkgdir/usr/share/icons/hicolor/${s}x${s}/apps/$bin.png"
    done
    install -Dm644 "packaging/icons/$bin.svg" \
      "$pkgdir/usr/share/icons/hicolor/scalable/apps/$bin.svg"
  done

  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  # the bundled faces (compiled into the binaries' frontend): Geist is OFL
  install -Dm644 packages/ui/src/fonts/Geist-OFL.txt "$pkgdir/usr/share/licenses/$pkgname/GEIST-OFL.txt"
}
