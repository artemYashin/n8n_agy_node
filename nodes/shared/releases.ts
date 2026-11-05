// Official Google release manifests, pinned on 2026-11-06.
// Source: https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/
export const releases: Record<string, { version: string; url: string; sha512: string }> = {
  "linux_amd64_musl": {
    "version": "1.5.1",
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-4523430503120896/linux-x64-musl/cli_linux_x64_musl.tar.gz",
    "sha512": "8a9fd080f10e8a873ce92fc815c0feebfdbf62468ef53fd99bb3474f14c4a7945965e083be71e5554f68af8a05b4aa3ae3af564fce65f18bc9735feb7d0dd334"
  },
  "linux_arm64_musl": {
    "version": "1.5.1",
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-4523430503120896/linux-arm-musl/cli_linux_arm64_musl.tar.gz",
    "sha512": "3cc930ee0b563059d00ce26daf5ef78551141dd252fb1b8ef1493b112a2e5953d7cba5de132941fe90bf6b11ee9f606d4268ba12e79244e01d8f256c30367e5e"
  },
  "darwin_amd64": {
    "version": "1.5.1",
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-4523430503120896/darwin-x64/cli_mac_x64.tar.gz",
    "sha512": "736a0f1210b42edc6ec292e1f8438696f616bf6906ad5e878d415b18aa53accc59a678205c332e5af564fab8d32ca5ac5b41c9baad8ced0a7bc224a0ccfcc3b5"
  },
  "darwin_arm64": {
    "version": "1.5.1",
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-4523430503120896/darwin-arm/cli_mac_arm64.tar.gz",
    "sha512": "078399b392c3bfce70bc5d9fb1a447a4b0a2a26bd40c36148f4944028b8f21e358890d5b9bedcde69296677b1da2c026b4e283ae918823429c13b91ddcb913ce"
  },
  "windows_amd64": {
    "version": "1.5.1",
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-4523430503120896/windows-x64/cli_windows_x64.exe",
    "sha512": "218d2751189e25a275122519a2afc6a3d0af5ff68306cebc68a5da3127bca69a497760988bfd40a884a619d4fa58ccafcb2fba1289dc1fc56e3d7d7b565f4cec"
  },
  "windows_arm64": {
    "version": "1.5.1",
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-4523430503120896/windows-arm/cli_windows_arm64.exe",
    "sha512": "f23080f15cfc91e798458d560378afe49e7f8a27df57d8cdca08b5cb0367a27c97bdf4aaec2ee0425ab71c87eb46fa6bdbeed99b2ae30fb19daebe08873a97ad"
  }
};
