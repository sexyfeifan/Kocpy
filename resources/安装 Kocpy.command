#!/bin/bash
# Kocpy Installer — removes macOS quarantine and copies to /Applications
set -e

APP="Kocpy.app"
DMG_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DMG_DIR/$APP"

if [ ! -d "$SRC" ]; then
  osascript -e 'display alert "找不到 Kocpy.app" message "请确保此脚本和 Kocpy.app 在同一个 DMG 中。" as critical'
  exit 1
fi

DEST="/Applications/$APP"

# Copy to /Applications (overwrite if exists)
cp -R "$SRC" "$DEST"

# Remove quarantine attribute recursively
xattr -rd com.apple.quarantine "$DEST" 2>/dev/null || true

osascript -e 'display notification "Kocpy 已安装到应用程序文件夹，可直接打开。" with title "安装完成 ✓"'

open /Applications
