#!/bin/bash
# 越聊 iOS 构建补丁。放在仓库根目录，由 workflow 在 native-ios 目录里调用：
#   bash ../patch-ios.sh pre    (在 xcodegen generate 之前)
#   bash ../patch-ios.sh post   (在 cp -R ... Payload/ 之后)
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"

case "${1:-}" in
pre)
  test -f project.yml || { echo "error: 请在 native-ios 目录里运行"; exit 1; }

  # 1) 图标：由仓库根目录的 AppIcon-1024.png 生成资源目录
  if [ -f "$ROOT/AppIcon-1024.png" ]; then
    SET=YueLiao/Assets.xcassets/AppIcon.appiconset
    mkdir -p "$SET"
    cp "$ROOT/AppIcon-1024.png" "$SET/AppIcon-1024.png"
    cat > YueLiao/Assets.xcassets/Contents.json <<'EOF'
{
  "info" : { "author" : "xcode", "version" : 1 }
}
EOF
    cat > "$SET/Contents.json" <<'EOF'
{
  "images" : [
    { "filename" : "AppIcon-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
EOF
  else
    echo "warning: 找不到 AppIcon-1024.png，本次构建不带图标"
  fi

  # 2) 重写 project.yml（在原有设置上增加：启动屏、摄像头说明、图标，并修正权限文案）
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
    sources: [YueLiao]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: cc.eu.yueliao.ios
        SWIFT_VERSION: '5.0'
        GENERATE_INFOPLIST_FILE: YES
        INFOPLIST_KEY_CFBundleDisplayName: 越聊
        INFOPLIST_KEY_UILaunchScreen_Generation: YES
        INFOPLIST_KEY_NSMicrophoneUsageDescription: 越聊需要使用麦克风，用于通话语音、实时字幕和翻译。
        INFOPLIST_KEY_NSSpeechRecognitionUsageDescription: 越聊需要使用语音识别，用于生成实时字幕和翻译。
        INFOPLIST_KEY_NSCameraUsageDescription: 越聊需要使用摄像头，用于视频通话。
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        TARGETED_DEVICE_FAMILY: '1'
        MARKETING_VERSION: '0.1.0'
        CURRENT_PROJECT_VERSION: '2'
    scheme:
      gatherCoverageData: false
EOF
  echo "patch-ios: pre 完成"
  ;;

post)
  PLIST=Payload/YueLiao.app/Info.plist
  test -f "$PLIST" || { echo "error: 找不到 $PLIST"; exit 1; }
  PB=/usr/libexec/PlistBuddy
  # 后台音频（通话时切到别的 App 麦克风不中断）、固定深色（避免启动时闪白屏）
  "$PB" -c "Delete :UIBackgroundModes" "$PLIST" 2>/dev/null || true
  "$PB" -c "Add :UIBackgroundModes array" -c "Add :UIBackgroundModes:0 string audio" "$PLIST"
  "$PB" -c "Delete :UIUserInterfaceStyle" "$PLIST" 2>/dev/null || true
  "$PB" -c "Add :UIUserInterfaceStyle string Dark" "$PLIST"
  "$PB" -c "Print" "$PLIST"
  echo "patch-ios: post 完成"
  ;;

*)
  echo "用法: bash ../patch-ios.sh pre|post"
  exit 1
  ;;
esac
