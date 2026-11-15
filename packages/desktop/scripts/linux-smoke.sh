#!/usr/bin/env bash
# Launch the packaged Linux installers the way users run them: the AppImage
# directly, and the .deb after installing it with apt.
set -euo pipefail
cd "$(dirname "$0")/../../.."
version=$(node -p 'require("./packages/desktop/package.json").version')
case "$(uname -m)" in
  x86_64) appimage_arch=x86_64 deb_arch=amd64 ;;
  aarch64) appimage_arch=arm64 deb_arch=arm64 ;;
  *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
appimage="$PWD/artifacts/desktop/Kody-$version-linux-$appimage_arch.AppImage"
deb="$PWD/artifacts/desktop/Kody-$version-linux-$deb_arch.deb"
chmod +x "$appimage"
xvfb-run -a npm run test:smoke --workspace @kodycodes/desktop -- "$appimage"
sudo apt-get install -y "$deb"
# Only release builds have an update feed, which is when electron-builder
# writes the marker that keeps .deb installs off electron-updater.
if [ "${KODY_DESKTOP_RELEASE:-}" = 1 ]; then
  test "$(cat /opt/Kody/resources/package-type)" = deb
fi
xvfb-run -a npm run test:smoke --workspace @kodycodes/desktop -- /opt/Kody/kody-desktop
