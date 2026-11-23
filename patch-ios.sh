#!/bin/bash
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$ROOT/native-ios"

case "${1:-}" in
  pre)
    if [ ! -f "$NATIVE/project.yml" ]; then
      echo "error: 找不到 native-ios/project.yml"
      exit 1
    fi
    cd "$NATIVE"

    if [ -f "$ROOT/AppIcon-1024.png" ]; then
      SET="YueLiao/Assets.xcassets/AppIcon.appiconset"
      mkdir -p "$SET"
      cp "$ROOT/AppIcon-1024.png" "$SET/AppIcon-1024.png"

      cat > "YueLiao/Assets.xcassets/Contents.json" <<'EOF'
{
  "info": {
    "author": "xcode",
    "version": 1
  }
}
EOF

      cat > "$SET/Contents.json" <<'EOF'
{
  "images": [
    {
      "filename": "AppIcon-1024.png",
      "idiom": "universal",
      "platform": "ios",
      "size": "1024x1024"
    }
  ],
  "info": {
    "author": "xcode",
    "version": 1
  }
}
EOF
    else
      echo "warning: 找不到 AppIcon-1024.png"
    fi

    cat > project.yml <<'EOF'
name: YueLiao

options:
  bundleIdPrefix: cc.eu.yueliao
  deploymentTarget:
    iOS: '18.0'

targets:
  YueLiao:
    type: application
    platform: iOS
    sources:
      - YueLiao
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: cc.eu.yueliao.ios
        SWIFT_VERSION: '5.0'
        GENERATE_INFOPLIST_FILE: YES
        INFOPLIST_KEY_CFBundleDisplayName: 越聊
        INFOPLIST_KEY_UILaunchScreen_Generation: YES
        INFOPLIST_KEY_UIUserInterfaceStyle: Dark
        INFOPLIST_KEY_NSMicrophoneUsageDescription: 越聊需要使用麦克风，用于语音通话和实时翻译。
        INFOPLIST_KEY_NSCameraUsageDescription: 越聊需要使用摄像头，用于视频通话。
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        TARGETED_DEVICE_FAMILY: '1'
        MARKETING_VERSION: '0.1.0'
        CURRENT_PROJECT_VERSION: '2'

schemes:
  YueLiao:
    build:
      targets:
        YueLiao: all
    gatherCoverageData: false
EOF
    echo "patch-ios: pre 完成"
    ;;
  post)
    PLIST="$ROOT/Payload/YueLiao.app/Info.plist"
    if [ ! -f "$PLIST" ]; then
      echo "error: 找不到 $PLIST"
      exit 1
    fi
    PB="/usr/libexec/PlistBuddy"
    if [ ! -x "$PB" ]; then
      echo "error: post 阶段需要 macOS PlistBuddy"
      exit 1
    fi

    "$PB" -c "Delete :UIBackgroundModes" "$PLIST" 2>/dev/null || true
    "$PB" -c "Add :UIBackgroundModes array" "$PLIST"
    "$PB" -c "Add :UIBackgroundModes:0 string audio" "$PLIST"

    "$PB" -c "Delete :UIUserInterfaceStyle" "$PLIST" 2>/dev/null || true
    "$PB" -c "Add :UIUserInterfaceStyle string Dark" "$PLIST"
    echo "patch-ios: post 完成"
    ;;
  *)
    echo "用法: bash patch-ios.sh pre|post"
    exit 1
    ;;
esac
