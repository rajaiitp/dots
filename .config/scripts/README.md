# Scripts

Scripts are grouped by the feature they support:

- `android/` — tablet tooling, Android app sources, and APK build scripts
- `audio/` — audio sink selection and volume controls
- `desktop/` — desktop UI helpers
- `display/` — brightness, display modes, HDMI, and display UI
- `firewall/` — firewall status, menus, GUI, and toggles
- `home/` — home-automation controls
- `network/` — VPN, Tailscale, and Multipass networking
- `setup/` — one-time setup and migration utilities

Generated Python caches and Android build output are ignored. Android APKs can be rebuilt with the scripts in `android/`.
