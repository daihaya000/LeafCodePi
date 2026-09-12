---
name: apk-reverse
description: >
  Android APKリバースエンジニアリング。 Trigger on APK逆向, decompile apk,
  android reverse, frida hook android, apk unpack, 安卓逆向, smali patch,
  rebuild apk, native .so analysis from APK.
---

# APK Reverse

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `decode(apktool)` を実行

## 適用範囲
- APKのdecode/rebuild/sign/install
- DEX → Java逆コンパイル (jadx)
- smaliレベルでの修正・署名・ネイティブ切替
- APK内 `.so` (ELF) の静的解析 → IDA Pro/radare2へ委譲
- Android向け Frida dynamic instrumentation
- anti-debug / root detection / SSL pinning bypass (CTF/ownedのみ)

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| jadx | yes | DEX→Java decompile | true |
| apktool | yes | APK decode/rebuild | true |
| adb | yes | device install/logcat | true |
| frida-tools / frida-server | yes | runtime hook | true |
| keytool/jarsigner | yes | APK resign | false |
| IDA Pro / radare2 | optional | .so native analysis | false/true |

## 工作流
1. **decode**: `apktool d -s target.apk -o ./out/apk_decoded`
   - `-s` でソース保持。resources + smali + libを分離
2. **jadx逆コンパイル**: `jadx -d ./out/jadx target.apk`
   - クラス名難読化時は `jadx --deobf` または rename-mappingsを出力
3. **検査**: `grep -R "verify\|anti\|root\|ssl\|signature" ./out/jadx`
   - 重点: `lib/arm64-v8a/lib*.so` のロード箇所
4. **smali修正**: `vim ./out/apk_decoded/smali_classes*/.../X.smali`
   - 定数リターンでチェックを打ち消す場合、`.locals` 増加を忘れず調整
5. **rebuild-sign-install**: スクリプト `../scripts/rebuild-sign-install.sh` を使用
   ```bash
   bash ../scripts/rebuild-sign-install.sh ./out/apk_decoded ./keystore.jks alias
   ```
6. **.so解析**: `lib/` からELFをコピーし `ida-reverse` または `radare2` skillへ
7. **Frida hook**: `../scripts/frida-run.js` テンプレートを改変してattach
   ```bash
   frida -U -f com.example.app -l hook.js --no-pause
   ```
8. **検証**: logcat + UI操作 → 目標関数の呼び出し・戻り値を確認

## 按需自举
- ツール不在時: `bash ../scripts/bootstrap.sh jadx apktool frida adb`
- `tool-index.md` が無い場合: `bash ../scripts/refresh-tool-index.sh`
- frida-server未root: Magisk/SuperSU環境で `/data/local/tmp/frida-server` をpushして実行
- jarsigner不在: OpenJDKを手動インストール (license-free)

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: `.so`解析 → `ida-reverse` or `radare2` ; 難読化JS → `js-reverse`
- 同级关联: `mobile-reverse` (iOS), `reverse-engineering` (OLLVM/anti-analysis)

## 任務完了自検
1. 授权明記 (local-sandbox/CTF/owned/書面授权)
2. jadx/apktool/adb/frida の実パスを `tool-index.md` で検証
3. decode → 検査 → smali修正 → rebuild-sign-install → hook の最後まで実行
4. `field-journal/precedent-reverse.md` または `_template.md` に蓄積
