#!/usr/bin/env bash
# Create an encrypted 4 GiB internal Arch rescue system on this exact machine.
#
# Layout after `prepare`:
#   nvme0n1p5 (unchanged encrypted Omarchy root) | free former-p4 space | p6 rescue
#
# Run, in order, from the normal Omarchy system:
#   sudo ./install-internal-rescue.sh prepare
#   # If asked, reboot normally, then:
#   sudo ./install-internal-rescue.sh install
#   sudo ./install-internal-rescue.sh test
#
# At the rescue prompt, unlock the rescue LUKS volume, log in as root, and run:
#   /root/internal-rescue.sh verify-rescue
# Then reboot normally and run:
#   sudo ./install-internal-rescue.sh verify-normal
#
# WARNING: `prepare` permanently deletes nvme0n1p4 after explicit confirmation.
set -Eeuo pipefail
IFS=$'\n\t'

DISK=/dev/nvme0n1
P4=${DISK}p4
P5=${DISK}p5
P6=${DISK}p6
ESP=${DISK}p2
MAPPER=rescue-root
LABEL='Arch Rescue (encrypted)'
TARGET=/mnt/internal-rescue
STATE=/root/.local/state/internal-rescue.env
SCRIPT_PATH=$(readlink -f "$0")
ALIGN_SECTORS=2048
MIN_BYTES=$((4 * 1024 * 1024 * 1024))
PKGS=(
  base linux amd-ucode
  linux-firmware-amdgpu linux-firmware-atheros linux-firmware-realtek
  mkinitcpio cryptsetup btrfs-progs e2fsprogs dosfstools
  gptfdisk parted nvme-cli efibootmgr networkmanager iwd nano
)

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
need_root() { [[ $EUID -eq 0 ]] || die "Run this script with sudo."; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }
confirm() {
  local expected=$1 answer
  read -r -p "Type exactly '${expected}' to continue: " answer
  [[ $answer == "$expected" ]] || die "Confirmation did not match; nothing further was done."
}
part_field() {
  local part=$1 key=$2
  sgdisk -i "$part" "$DISK" | awk -v key="$key" '$0 ~ key {print $3; exit}'
}
part_guid() {
  sgdisk -i "$1" "$DISK" | awk -F': ' '/Partition unique GUID/ {print $2; exit}'
}
part_type() {
  sgdisk -i "$1" "$DISK" | awk -F': ' '/Partition GUID code/ {print $2; exit}' | awk '{print $1}'
}
last_usable_sector() {
  sgdisk -p "$DISK" | sed -n 's/^First usable sector is [0-9][0-9]*, last usable sector is \([0-9][0-9]*\)$/\1/p'
}
source_device_for() {
  findmnt -rn -T "$1" -o SOURCE | awk 'NR == 1 {print}'
}
require_external_backup_dir() {
  local source backing
  if [[ ${ALLOW_ON_P5_BACKUP:-0} == 1 ]]; then
    BACKUP_DIR=${BACKUP_DIR:-/root/rescue-preflight}
    printf '\nWARNING: saving GPT/LUKS recovery artifacts on p5 by explicit request. They are not independent disk recovery copies.\n'
  elif [[ -z ${BACKUP_DIR:-} ]]; then
    read -r -e -p 'Path to an existing directory on verified external or remote backup storage: ' BACKUP_DIR
  fi
  [[ -n $BACKUP_DIR ]] || die "A backup directory is required."
  mkdir -p "$BACKUP_DIR"
  source=$(source_device_for "$BACKUP_DIR")
  [[ -n $source ]] || die "Cannot identify the filesystem containing $BACKUP_DIR."
  source=${source%%\[*}
  backing=$(lsblk -no PKNAME "$(readlink -f "$source" 2>/dev/null || printf %s "$source")" 2>/dev/null | awk 'NR == 1 {print}')
  if [[ ${ALLOW_ON_P5_BACKUP:-0} != 1 ]]; then
    [[ $source != "$P4" && $source != "$P5" && $backing != nvme0n1p4 && $backing != nvme0n1p5 ]] || \
      die "Backup directory is on this disk's p4/p5; choose external or remote storage."
  fi
  BACKUP_ROOT=$(readlink -f "$BACKUP_DIR")
  RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)
  BDIR="$BACKUP_ROOT/internal-rescue-$RUN_ID"
  mkdir -p "$BDIR"
  chmod 700 "$BDIR"
}
write_state() {
  mkdir -p "$(dirname "$STATE")"
  umask 077
  {
    printf 'DISK=%q\n' "$DISK"
    printf 'P4=%q\nP5=%q\nP6=%q\nESP=%q\nMAPPER=%q\n' "$P4" "$P5" "$P6" "$ESP" "$MAPPER"
    printf 'P5_START=%q\nP5_END=%q\nP5_GUID=%q\nP5_TYPE=%q\nP5_LUKS_UUID=%q\nP5_HEADER_HASH=%q\n' \
      "$P5_START" "$P5_END" "$P5_GUID" "$P5_TYPE" "$P5_LUKS_UUID" "$P5_HEADER_HASH"
    printf 'P6_START=%q\nP6_END=%q\nP6_PARTUUID=%q\n' "$P6_START" "$P6_END" "$P6_PARTUUID"
    printf 'ESP_MOUNT=%q\nBOOTORDER=%q\nBOOTCURRENT=%q\nBDIR=%q\n' "$ESP_MOUNT" "$BOOTORDER" "$BOOTCURRENT" "$BDIR"
    [[ -n ${RESCUE_LUKS_UUID:-} ]] && printf 'RESCUE_LUKS_UUID=%q\n' "$RESCUE_LUKS_UUID"
    [[ -n ${RESCUE_BOOT:-} ]] && printf 'RESCUE_BOOT=%q\n' "$RESCUE_BOOT"
  } >"$STATE"
  chmod 600 "$STATE"
}
load_state() {
  [[ -r $STATE ]] || die "No state file at $STATE. Run prepare first."
  # shellcheck disable=SC1090
  source "$STATE"
  [[ $DISK == /dev/nvme0n1 && $P5 == /dev/nvme0n1p5 && $P6 == /dev/nvme0n1p6 ]] || die "State file does not describe the expected disk."
}
ensure_helpers() {
  if command -v sgdisk >/dev/null && command -v pacstrap >/dev/null; then
    return
  fi
  log 'Host helper packages are required: gptfdisk and arch-install-scripts'
  printf 'This installs only those two helper packages on the current system; it does not delete data.\n'
  confirm 'INSTALL HOST HELPERS'
  pacman -S --needed gptfdisk arch-install-scripts
  command -v sgdisk >/dev/null && command -v pacstrap >/dev/null || die "Helper installation failed."
}
assert_base_layout() {
  [[ -b $DISK && -b $P4 && -b $P5 && -b $ESP ]] || die "Expected p2, p4, and p5 are not present on $DISK."
  [[ $(blkid -s TYPE -o value "$P4") == ext4 ]] || die "$P4 is not ext4."
  [[ $(blkid -s TYPE -o value "$P5") == crypto_LUKS ]] || die "$P5 is not LUKS."
  P5_START=$(part_field 5 'First sector:')
  P5_END=$(part_field 5 'Last sector:')
  P5_GUID=$(part_guid 5)
  P5_TYPE=$(part_type 5)
  P4_START=$(part_field 4 'First sector:')
  P4_END=$(part_field 4 'Last sector:')
  (( P4_START > P5_END )) || die "p4 is not physically after p5; refusing."
  [[ $(part_type 4) == 0FC63DAF-8483-4772-8E79-3D69D8477DE4 ]] || die "p4 is not a Linux filesystem GPT partition."
  [[ $(findmnt -rn -S "$ESP" -o TARGET | awk 'NR == 1 {print}') == /boot ]] || die "p2 is not the active /boot ESP."
  ESP_MOUNT=/boot
}
assert_no_p4_references() {
  local p4_uuid p4_partuuid p4_label ref
  p4_uuid=$(blkid -s UUID -o value "$P4")
  p4_partuuid=$(blkid -s PARTUUID -o value "$P4")
  p4_label=$(blkid -s LABEL -o value "$P4" || true)
  for ref in "$p4_uuid" "$p4_partuuid" "$p4_label"; do
    [[ -z $ref ]] && continue
    if grep -R -F -l -- "$ref" /etc/fstab /etc/crypttab /etc/systemd 2>/dev/null | grep -q .; then
      die "Found a p4 reference ($ref) in fstab, crypttab, or /etc/systemd. Remove it deliberately, then rerun."
    fi
  done
  if swapon --noheadings --raw --show=NAME | grep -Fxq "$P4"; then
    die "p4 is active swap."
  fi
  [[ ! -e /sys/class/block/nvme0n1p4/holders/* ]] || die "p4 has a device-mapper/LVM/MD holder."
}
record_preflight() {
  log "Recording disk, LUKS, ESP, and UEFI state in $BDIR"
  lsblk -d -o NAME,MODEL,SERIAL,WWN,SIZE "$DISK" | tee "$BDIR/disk-identity.txt"
  sgdisk -p "$DISK" | tee "$BDIR/gpt-before.txt"
  sgdisk -i 5 "$DISK" | tee "$BDIR/p5-before.txt"
  sgdisk -i 4 "$DISK" | tee "$BDIR/p4-before.txt"
  sgdisk --backup="$BDIR/nvme0n1-gpt-before.bin" "$DISK"
  cryptsetup luksUUID "$P5" | tee "$BDIR/p5-luks-uuid.txt"
  cryptsetup luksHeaderBackup "$P5" --header-backup-file "$BDIR/p5-luks-header-before.bin"
  chmod 600 "$BDIR/p5-luks-header-before.bin"
  sha256sum "$BDIR/p5-luks-header-before.bin" | tee "$BDIR/p5-luks-header-before.sha256"
  (cd "$ESP_MOUNT" && find . -xdev -type f -print0 | sort -z | xargs -0 -r sha256sum) >"$BDIR/esp-before.sha256"
  efibootmgr -v | tee "$BDIR/efi-before.txt"
  [[ ! $(efibootmgr | awk -F: '/^BootNext:/{print $2}') ]] || die "BootNext is already set; do not overwrite another pending one-time boot."
  BOOTORDER=$(efibootmgr | awk -F: '/^BootOrder:/{gsub(/^ /, "", $2); print $2}')
  BOOTCURRENT=$(efibootmgr | awk -F: '/^BootCurrent:/{gsub(/^ /, "", $2); print $2}')
  [[ -n $BOOTORDER && -n $BOOTCURRENT ]] || die "Could not read current UEFI BootOrder/BootCurrent."
  P5_LUKS_UUID=$(<"$BDIR/p5-luks-uuid.txt")
  P5_HEADER_HASH=$(awk '{print $1}' "$BDIR/p5-luks-header-before.sha256")
}
verify_p5_unchanged() {
  local now_guid now_type now_start now_end now_header now_hash
  now_start=$(part_field 5 'First sector:')
  now_end=$(part_field 5 'Last sector:')
  now_guid=$(part_guid 5)
  now_type=$(part_type 5)
  [[ $now_start == "$P5_START" && $now_end == "$P5_END" && $now_guid == "$P5_GUID" && $now_type == "$P5_TYPE" ]] || \
    die "p5 GPT geometry or identity changed unexpectedly."
  now_header=$(mktemp)
  rm -f "$now_header" # cryptsetup refuses to overwrite an existing header-backup path.
  cryptsetup luksHeaderBackup "$P5" --header-backup-file "$now_header"
  now_hash=$(sha256sum "$now_header" | awk '{print $1}')
  rm -f "$now_header"
  [[ $now_hash == "$P5_HEADER_HASH" ]] || die "p5 LUKS header changed unexpectedly."
}
prepare() {
  need_root
  ensure_helpers
  need_cmd cryptsetup; need_cmd efibootmgr; need_cmd blockdev; need_cmd partprobe; need_cmd udevadm
  [[ ! -e $STATE ]] || die "State already exists at $STATE. Do not run prepare twice."
  require_external_backup_dir
  assert_base_layout
  assert_no_p4_references
  [[ ! -b $P6 ]] || die "$P6 already exists; refusing to reuse it."
  local serial
  serial=$(lsblk -dn -o SERIAL "$DISK" | xargs)
  [[ -n $serial ]] || die "Could not determine NVMe serial."
  log "Target disk identity"
  lsblk -d -o NAME,MODEL,SERIAL,WWN,SIZE "$DISK"
  printf '\np4 (%s) is mounted data that will be irreversibly deleted. p5 will not be resized or reformatted.\n' "$P4"
  printf 'Preflight artifacts will be saved to: %s\n' "$BDIR"
  confirm "$serial"
  record_preflight
  confirm 'DELETE nvme0n1p4'

  log 'Unmounting and deleting only p4'
  if findmnt -rn -S "$P4" >/dev/null; then
    umount "$P4" || die "Could not unmount p4. Close all applications using projects-backup and retry."
  fi
  udevadm settle
  [[ ! -e /sys/class/block/nvme0n1p4/holders/* ]] || die "p4 gained a holder after unmount."
  sgdisk --delete=4 "$DISK"

  local sector_size last raw_start
  sector_size=$(blockdev --getss "$DISK")
  (( MIN_BYTES % sector_size == 0 )) || die "4 GiB is not sector-aligned on this disk."
  last=$(last_usable_sector)
  [[ $last =~ ^[0-9]+$ ]] || die "Could not determine last usable GPT sector."
  raw_start=$((last - MIN_BYTES / sector_size + 1))
  P6_START=$(((raw_start / ALIGN_SECTORS) * ALIGN_SECTORS))
  P6_END=$last
  (( P6_START > P5_END )) || die "Calculated rescue partition would overlap p5."
  sgdisk --new=6:${P6_START}:${P6_END} --typecode=6:8309 --change-name=6:'Rescue LUKS' "$DISK"
  sgdisk --verify "$DISK"
  P6_PARTUUID=$(part_guid 6)
  verify_p5_unchanged
  write_state
  sgdisk -p "$DISK" | tee "$BDIR/gpt-after-create.txt"

  log 'Requesting the kernel re-read the GPT'
  partprobe "$DISK" || true
  udevadm settle
  if [[ ! -b $P6 ]]; then
    cat <<EOF

The on-disk GPT is correct but the running kernel did not expose p6 without
re-reading a disk that contains the active root. Reboot normally through the
unchanged default entry, then run:
  sudo $SCRIPT_PATH install
EOF
    exit 0
  fi
  printf '\np6 is available. Continue with:\n  sudo %q install\n' "$SCRIPT_PATH"
}
recover_prepare() {
  need_root
  need_cmd sgdisk; need_cmd cryptsetup
  [[ ! -e $STATE ]] || die "State already exists at $STATE; use install instead."
  BDIR=${2:-$(find /root/rescue-preflight -mindepth 2 -maxdepth 2 -type f -name p5-before.txt -printf '%h\n' 2>/dev/null | sort | tail -n 1)}
  [[ -d $BDIR && -r $BDIR/p5-before.txt && -r $BDIR/p5-luks-header-before.sha256 && -r $BDIR/efi-before.txt ]] || \
    die "Provide the preflight directory: sudo $SCRIPT_PATH recover-prepare /root/rescue-preflight/<timestamp>"
  [[ ! -b $P4 && -b $P6 ]] || die "Expected p4 to be absent and p6 to be visible after the normal reboot."
  assert_base_layout_recovered() {
    [[ -b $DISK && -b $P5 && -b $ESP ]] || die "Expected disk, p2, and p5 are not present."
    [[ $(blkid -s TYPE -o value "$P5") == crypto_LUKS ]] || die "p5 is not LUKS."
    ESP_MOUNT=$(findmnt -rn -S "$ESP" -o TARGET | awk 'NR == 1 {print}')
    [[ $ESP_MOUNT == /boot ]] || die "p2 is not mounted at /boot."
  }
  assert_base_layout_recovered
  P5_START=$(part_field 5 'First sector:')
  P5_END=$(part_field 5 'Last sector:')
  P5_GUID=$(part_guid 5)
  P5_TYPE=$(part_type 5)
  cmp -s "$BDIR/p5-before.txt" <(sgdisk -i 5 "$DISK") || die "p5 GPT fields do not match the pre-delete record."
  P5_LUKS_UUID=$(cryptsetup luksUUID "$P5")
  P5_HEADER_HASH=$(awk '{print $1}' "$BDIR/p5-luks-header-before.sha256")
  P6_START=$(part_field 6 'First sector:')
  P6_END=$(part_field 6 'Last sector:')
  P6_PARTUUID=$(part_guid 6)
  [[ $(part_type 6) == CA7D7CCB-63ED-4C53-861C-1742536059CC ]] || die "p6 is not a Linux LUKS GPT partition."
  [[ -z $(blkid -s TYPE -o value "$P6" || true) ]] || die "p6 is unexpectedly formatted; refusing to resume."
  BOOTORDER=$(awk -F: '/^BootOrder:/{gsub(/^ /, "", $2); print $2; exit}' "$BDIR/efi-before.txt")
  BOOTCURRENT=$(efibootmgr | awk -F: '/^BootCurrent:/{gsub(/^ /, "", $2); print $2}')
  [[ $(efibootmgr | awk -F: '/^BootOrder:/{gsub(/^ /, "", $2); print $2}') == "$BOOTORDER" ]] || die "BootOrder changed since preflight."
  verify_p5_unchanged
  write_state
  log 'Recovered preflight state validated. Continue with:'
  printf '  sudo %q install\n' "$SCRIPT_PATH"
}

cleanup_install() {
  set +e
  # pacstrap can leave a target-local gpg-agent holding the mount.
  fuser -km "$TARGET" >/dev/null 2>&1 || true
  mountpoint -q "$TARGET" && umount -R "$TARGET"
  cryptsetup status "$MAPPER" >/dev/null 2>&1 && cryptsetup close "$MAPPER"
}
install_rescue() {
  need_root
  load_state
  need_cmd pacstrap; need_cmd arch-chroot; need_cmd mkinitcpio; need_cmd cryptsetup
  [[ ! -b $P4 ]] || die "p4 still exists; run prepare first."
  [[ -b $P6 ]] || die "p6 is not visible. Reboot normally, then rerun install."
  [[ $(part_guid 6) == "$P6_PARTUUID" ]] || die "p6 PARTUUID differs from the saved state."
  [[ $(part_field 6 'First sector:') == "$P6_START" && $(part_field 6 'Last sector:') == "$P6_END" ]] || die "p6 geometry differs from the saved state."
  verify_p5_unchanged
  local resuming=0
  if [[ $(blkid -s TYPE -o value "$P6" || true) == crypto_LUKS ]]; then
    if ! cryptsetup status "$MAPPER" >/dev/null 2>&1; then
      log 'Unlock the existing rescue volume to resume its interrupted installation'
      cryptsetup open "$P6" "$MAPPER"
    fi
    mkdir -p "$TARGET"
    mountpoint -q "$TARGET" || mount "/dev/mapper/$MAPPER" "$TARGET"
    [[ -f "$TARGET/etc/os-release" ]] || die "p6 is encrypted but does not contain a usable rescue installation."
    resuming=1
    log 'Resuming the existing rescue installation after an interrupted build'
  else
    [[ -z $(blkid -s TYPE -o value "$P6" || true) ]] || die "p6 already has a filesystem/signature; refusing to overwrite it."
  fi
  [[ ! $(efibootmgr | awk -F: '/^BootNext:/{print $2}') ]] || die "BootNext is set; do not overwrite it."
  local existing_boot
  existing_boot=$(efibootmgr | awk -v label="$LABEL" 'index($0, label) {x=$1; sub(/^Boot/, "", x); sub(/\*.*/, "", x); if (!seen) {print x; seen=1}}')
  if [[ -n $existing_boot && $resuming -eq 0 ]]; then
    die "A UEFI entry named '$LABEL' already exists; refusing to create a duplicate."
  fi
  if [[ -e "$ESP_MOUNT/EFI/Linux/rescue-linux.efi" && $resuming -eq 0 ]]; then
    die "Rescue UKI path already exists on the ESP."
  fi

  if (( ! resuming )); then
    confirm 'FORMAT ENCRYPTED RESCUE P6'
    log 'Creating and re-opening the encrypted rescue volume; set a unique rescue passphrase now'
    cryptsetup luksFormat --type luks2 --label rescue "$P6"
    cryptsetup open "$P6" "$MAPPER"
    cryptsetup close "$MAPPER"
    cryptsetup open "$P6" "$MAPPER"
    mkfs.ext4 -F -L rescue-root "/dev/mapper/$MAPPER"
  elif ! cryptsetup status "$MAPPER" >/dev/null 2>&1; then
    cryptsetup open "$P6" "$MAPPER"
  fi
  RESCUE_LUKS_UUID=$(cryptsetup luksUUID "$P6")

  trap cleanup_install EXIT
  mkdir -p "$TARGET"
  mountpoint -q "$TARGET" || mount "/dev/mapper/$MAPPER" "$TARGET"
  if (( ! resuming )); then
    log 'Installing the independent minimal Arch rescue system'
    pacstrap -K "$TARGET" "${PKGS[@]}"
    rm -rf "$TARGET/var/cache/pacman/pkg/"*
  fi
  cat >"$TARGET/etc/fstab" <<EOF
/dev/mapper/$MAPPER / ext4 rw,relatime 0 1
EOF
  cat >"$TARGET/etc/mkinitcpio.conf" <<'EOF'
MODULES=(nvme ext4 dm-crypt)
BINARIES=()
FILES=()
HOOKS=(base systemd autodetect microcode modconf kms keyboard sd-vconsole block sd-encrypt filesystems fsck)
COMPRESSION="zstd"
EOF
  cat >"$TARGET/etc/locale.conf" <<'EOF'
LANG=C.UTF-8
EOF
  printf 'rescue\n' >"$TARGET/etc/hostname"
  arch-chroot "$TARGET" systemctl enable NetworkManager

  if (( ! resuming )); then
    log 'Set a unique root password for the rescue system'
    arch-chroot "$TARGET" passwd
  fi

  local kver avail
  kver=$(find "$TARGET/usr/lib/modules" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tail -n 1)
  [[ -n $kver ]] || die "No target kernel modules found."
  cat >"$TARGET/etc/kernel/cmdline" <<EOF
rd.luks.name=$RESCUE_LUKS_UUID=$MAPPER root=/dev/mapper/$MAPPER rootfstype=ext4 rw
EOF
  arch-chroot "$TARGET" mkinitcpio -k "$kver" -U /root/rescue-linux.efi \
    --cmdline /etc/kernel/cmdline \
    --kernelimage "/usr/lib/modules/$kver/vmlinuz" \
    --uefistub /usr/lib/systemd/boot/efi/linuxx64.efi.stub
  [[ -s "$TARGET/root/rescue-linux.efi" ]] || die "UKI was not built."
  file "$TARGET/root/rescue-linux.efi" | tee "$BDIR/rescue-uki-inspect.txt"
  objdump -f "$TARGET/root/rescue-linux.efi" | tee -a "$BDIR/rescue-uki-inspect.txt"
  avail=$(df -B1 --output=avail "$TARGET" | awk 'NR == 2 {print $1}')
  (( avail >= 1024 * 1024 * 1024 )) || die "Rescue filesystem has less than 1 GiB free after installation."

  # The ESP is intentionally kept on the normal system's /boot mount. Copy only
  # this new UKI; do not touch Limine or the existing Omarchy UKI.
  local esp_avail tmp_uki final_uki order_after
  esp_avail=$(df -B1 --output=avail "$ESP_MOUNT" | awk 'NR == 2 {print $1}')
  (( esp_avail >= 512 * 1024 * 1024 )) || die "ESP has less than 512 MiB free."
  (cd "$ESP_MOUNT" && find . -xdev -type f -print0 | sort -z | xargs -0 -r sha256sum) >"$BDIR/esp-pre-copy.sha256"
  tmp_uki="$ESP_MOUNT/EFI/Linux/.rescue-linux.efi.new"
  final_uki="$ESP_MOUNT/EFI/Linux/rescue-linux.efi"
  if [[ -e $final_uki && $resuming -eq 1 ]]; then
    cmp -s "$TARGET/root/rescue-linux.efi" "$final_uki" || die "The existing ESP UKI differs from the rebuilt rescue UKI; inspect before replacing it."
  else
    install -m 0644 "$TARGET/root/rescue-linux.efi" "$tmp_uki"
    sync -f "$tmp_uki" || sync
    mv "$tmp_uki" "$final_uki"
    sync
  fi
  (cd "$ESP_MOUNT" && find . -xdev -type f -print0 | sort -z | xargs -0 -r sha256sum) >"$BDIR/esp-after.sha256"
  diff -u "$BDIR/esp-pre-copy.sha256" "$BDIR/esp-after.sha256" | tee "$BDIR/esp-delta.txt" || true

  if [[ -n $existing_boot ]]; then
    RESCUE_BOOT=$existing_boot
    log "Using existing non-default UEFI rescue entry $RESCUE_BOOT"
  else
    log 'Creating a non-default UEFI rescue entry'
    efibootmgr --create-only --disk "$DISK" --part 2 --label "$LABEL" --loader '\EFI\Linux\rescue-linux.efi'
    RESCUE_BOOT=$(efibootmgr | awk -v label="$LABEL" 'index($0, label) {x=$1; sub(/^Boot/, "", x); sub(/\*.*/, "", x); if (!seen) {print x; seen=1}}')
  fi
  [[ $RESCUE_BOOT =~ ^[0-9A-Fa-f]{4}$ ]] || die "Could not identify the rescue UEFI boot entry."
  order_after=$(efibootmgr | awk -F: '/^BootOrder:/{gsub(/^ /, "", $2); print $2}')
  [[ $order_after == "$BOOTORDER" ]] || die "BootOrder changed; do not reboot until you restore it from $BDIR/efi-before.txt."
  RESCUE_BOOT=${RESCUE_BOOT^^}
  write_state
  install -Dm700 "$SCRIPT_PATH" "$TARGET/root/internal-rescue.sh"
  install -Dm600 "$STATE" "$TARGET/root/internal-rescue.env"
  cat >"$TARGET/root/rebuild-rescue-uki.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
mountpoint -q /efi || mount $ESP /efi
kver=\$(find /usr/lib/modules -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort | tail -n 1)
mkinitcpio -k "\$kver" -U /root/rescue-linux.efi --cmdline /etc/kernel/cmdline --kernelimage "/usr/lib/modules/\$kver/vmlinuz" --uefistub /usr/lib/systemd/boot/efi/linuxx64.efi.stub
install -m 0644 /root/rescue-linux.efi /efi/EFI/Linux/.rescue-linux.efi.new
sync -f /efi/EFI/Linux/.rescue-linux.efi.new || sync
mv /efi/EFI/Linux/.rescue-linux.efi.new /efi/EFI/Linux/rescue-linux.efi
sync
EOF
  chmod 700 "$TARGET/root/rebuild-rescue-uki.sh"
  log 'Rescue installation complete'
  cat <<EOF

A non-default UEFI entry $RESCUE_BOOT was created. BootOrder was preserved.
Set it for one boot and test it with:
  sudo $SCRIPT_PATH test

After booting it, run /root/internal-rescue.sh verify-rescue as root, then reboot
normally and run: sudo $SCRIPT_PATH verify-normal

When you update packages inside rescue later, run /root/rebuild-rescue-uki.sh
as root before rebooting it again.
EOF
}
boot_test() {
  need_root
  load_state
  [[ -n ${RESCUE_BOOT:-} ]] || die "No rescue boot entry in the state file; run install first."
  [[ ! $(efibootmgr | awk -F: '/^BootNext:/{print $2}') ]] || die "BootNext is already set."
  [[ $(efibootmgr | awk -F: '/^BootOrder:/{gsub(/^ /, "", $2); print $2}') == "$BOOTORDER" ]] || die "BootOrder no longer matches preflight state."
  confirm "BOOT RESCUE $RESCUE_BOOT"
  efibootmgr --bootnext "$RESCUE_BOOT"
  sync
  systemctl reboot
}
verify_rescue() {
  need_root
  local rescue_state=/root/internal-rescue.env
  [[ -r $rescue_state ]] || die "Run this command from the installed rescue system."
  # shellcheck disable=SC1090
  source "$rescue_state"
  [[ $(findmnt -rn -o SOURCE /) == "/dev/mapper/$MAPPER" ]] || die "Rescue root is not $MAPPER."
  [[ $(findmnt -rn -o FSTYPE /) == ext4 ]] || die "Rescue root is not ext4."
  if cryptsetup status omarchy_root >/dev/null 2>&1 || findmnt -rn -S "$P5" >/dev/null; then
    die "p5 was opened or mounted; do not modify it during this test."
  fi
  [[ $(efibootmgr | awk -F: '/^BootCurrent:/{gsub(/^ /, "", $2); print toupper($2)}') == "${RESCUE_BOOT^^}" ]] || die "Firmware did not boot the rescue UEFI entry."
  grep -Fq "rd.luks.name=$RESCUE_LUKS_UUID=$MAPPER" /proc/cmdline || die "Unexpected rescue kernel command line."
  systemctl is-enabled NetworkManager >/dev/null
  command -v cryptsetup btrfs sgdisk parted >/dev/null
  log 'Rescue validation passed: root is p6, tools are present, and p5 is untouched.'
  printf 'Reboot normally. Do not resize p5 until a separately planned operation.\n'
}
verify_normal() {
  need_root
  load_state
  verify_p5_unchanged
  [[ ! $(efibootmgr | awk -F: '/^BootNext:/{print $2}') ]] || die "BootNext did not clear."
  [[ $(efibootmgr | awk -F: '/^BootOrder:/{gsub(/^ /, "", $2); print $2}') == "$BOOTORDER" ]] || die "BootOrder changed."
  [[ -e "$ESP_MOUNT/EFI/Linux/rescue-linux.efi" ]] || die "Rescue UKI is missing from the ESP."
  efibootmgr | grep -Fq "$LABEL" || die "Rescue UEFI entry is missing."
  log 'Normal-boot validation passed: p5 and BootOrder match preflight state.'
}

case ${1:-} in
  prepare) prepare ;;
  install) install_rescue ;;
  test) boot_test ;;
  verify-rescue) verify_rescue ;;
  verify-normal) verify_normal ;;
  recover-prepare) recover_prepare "$@" ;;
  *)
    printf 'Usage: sudo %s {prepare|recover-prepare|install|test|verify-rescue|verify-normal}\n' "$SCRIPT_PATH" >&2
    exit 2
    ;;
esac
