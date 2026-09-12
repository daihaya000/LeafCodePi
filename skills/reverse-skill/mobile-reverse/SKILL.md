---
name: mobile-reverse
description: >
  Android＋iOSモバイルのリバースエンジニアリングと動的計装。
  Trigger on mobile reverse, ios reverse, android reverse, objection,
  class-dump, mastg, frida mobile, ios jailbreak, 移动安全, SSL pinning bypass,
  root detection bypass, iOS hook, Android anti-detection.
---

# Mobile Reverse (Android + iOS)

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `platform identify` を実行

## 適用範囲
- Android APK: Java/Kotlin 层逆向 → JADX, 动态 → Frida / Objection
- iOS IPA: Mach-O 静态 → class-dump / Hopper / IDA, 动态 → Frida / Objection
- SSL pinning bypass (TrustKit, OkHttp, NSURLPinningValidator, Flutter)
- Root / jailbreak detection bypass (SafetyNet, Frida detection, ptrace)
- MASTG (OWASP Mobile Application Security Testing Guide) checklist 对照
- 仅 authorized: CTF/lab/owned device / written authorization

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| JADX | yes | Android DEX→Java decompile | true |
| Frida (tools + server) | yes | cross-platform dynamic hook | true |
| Objection | yes | Frida wrapper for mobile | true |
| class-dump / class-dump-z | iOS | Objective-C header dump | true |
| apktool | yes | APK decode/rebuild | true |
| adb | Android | device bridge | true |
| ios-deploy / libimobiledevice | iOS | IPA install / debug | true |
| ssl-kill-switch2 | iOS | SSL pinning disable tweak | false |
| Android Emulator / test device | yes | runtime target | false |

## 工作流
1. **platform identify**: `file target.apk` または `file Payload/*.app/<binary>`
   - Android: `unzip -l target.apk | grep classes`
   - iOS: `unzip -l target.ipa | grep Payload` → `.app` 内 Mach-O
2. **env setup**
   - Android: emulator または root 化実機; `adb root`, `adb remount`
   - iOS: jailbroken device; Cydia 経由で Frida server / ssl-kill-switch2 インストール
3. **static analysis**
   - Android: `jadx -d ./out/jadx target.apk`
   - iOS: `class-dump -H Payload/*.app/<binary> -o ./out/headers`
   - 検索: `grep -R "isJailbroken\|isRooted\|SSLPinning\|antiFrida" ./out/`
4. **dynamic instrumentation**
   - Android: `frida -U -f com.example.app -l hook.js --no-pause`
   - iOS: `frida -U -f com.example.app -l hook.js --no-pause`
   - Objection: `objection --gadget com.example.app explore`
5. **bypass**
   - SSL pinning: Objection `android sslpinning disable` / `ios sslpinning disable`
   - Root detection: hook `java.io.File.exists()` または `libc.so` の `stat()`
   - Jailbreak detection: hook `-[NSFileManager fileExistsAtPath:]` / `access()`
   - Frida detection: 文字列置換、frida-server 改名、ポート変更
   - Flutter: hook `SSL_CTX_set_custom_verify` via Frida script
   - React Native: SSL handshake override in `com.facebook.react.modules.network`
6. **MASTG checklist**
   - MASTG-PLATFORM-01~11, MASTG-CODE-01~09 をチェックシート化
   - 対応項目を `../field-journal/_template.md` にマッピング
   - 未カバー項目を列挙し次タスクへ

## 按需自举
- ツール不在: `bash ../scripts/bootstrap.sh jadx frida objection apktool adb class-dump`
- iOS 実機不在: Corellium または Xcode Simulator + static only
- Frida server 起動: `adb push frida-server /data/local/tmp/ && adb shell chmod +x /data/local/tmp/frida-server && adb shell /data/local/tmp/frida-server &`
- tool-index 不在: `bash ../scripts/refresh-tool-index.sh`

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: native `.so` / Mach-O 解析 → `ida-reverse` or `radare2`
- 同级关联: `apk-reverse` (Android only), `api-security` (backend traffic)

## 任務完了自検
1. 授权明記 (local-sandbox/CTF/owned/書面授权)
2. JADX / Frida / Objection / class-dump の実パスを `tool-index.md` で検証
3. platform identify → static → dynamic → bypass → MASTG まで実行
4. 発見を `field-journal/precedent-reverse.md` または `_template.md` に蓄積
