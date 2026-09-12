---
name: js-reverse
description: >
  フロントエンドJavaScriptのリバースエンジニアリングとDSL VM解析。 Trigger on
  js reverse, frontend signature, 前端逆向, js deobfuscation, 补环境,
  DSL VM, custom opcode VM, browser hook, sign locate.
---

# JS Reverse

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `Observe(ブラウザ)` を実行

## 適用範囲
- 前端JS署名生成位置の特定 (sign / token / sig parameter)
- ブラウザランタイムでのsampling / hook (jshookmcp / CDP)
- Node.js補環境復元 (axios/http/crypto/buffer polyfill)
- 独自DSL VM / custom opcode VM の逆解析
- IIFE-packed / 難読化JSの復元 (strings / const table / AST)

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| js-reverse MCP | yes | JS analysis entry | false |
| jshookmcp / frida | yes | runtime hook | false/true |
| Node.js | yes | 補環境・RPC実行 | true |
| Chrome DevTools Protocol | yes | ブラウザobserve | false |
| Babel/parser (astexplorer) | optional | AST操作 | true |

## 工作流 (通常JS)
1. **Observe(ブラウザ)**: 対象ページを開き DevTools Network で sign parameter を特定
   - keyword: `sig`, `sign`, `token`, `_st`, `x-s`, `authorization`
2. **署名定位**: CDP / jshookmcp で該当文字列生成直前に breakpoint
3. **hook(jshookmcp)**: 関数入口・出口をlog
   ```js
   // jshookmcp template
   Interceptor.attach(Module.findExportByName(null, "_signature"), {
     onLeave(retval) { console.log("sign:", retval.readUtf8String()); }
   });
   ```
4. **補環境復元**: ブラウザ特有API (window/document/navigator/canvas) をNodeでpolyfill
   ```js
   global.window = { ... }; global.document = { ... };
   ```
5. **RPC呼出**: sign関数をexportまたはIIFEから切り出してNodeで実行
6. **検証**: 生成signを実requestに差し込み、サーバ応答200を確認

## 工作流 (DSL VM / Custom Opcode)
1. **pattern match**: IIFE + 単字母変数 + `switch-case` opcode dispatcher
2. **opcode/const table抽出**: VM起動直前の大配列をdump
   ```js
   // ブラウザconsoleで table を globalに露出
   window.__vm_tables = [opcodes, consts, handlers];
   ```
3. **dispatcher解析**: opcode → handler index → 演算種別を対応表作成
4. **bytecode trace**: `Proxy` で配列アクセスをhookし実行trace取得
5. **semantics復元**: トレースから等高線SQL/式を復元
6. **cross-skill**: 必要時 `../references/routing.md` → `reverse-engineering`

## 按需自举
- ツール不在: `bash ../scripts/bootstrap.sh node frida`
- `js-reverse MCP` / `jshookmcp` 未接続: MCP server追加手順を表示
- ブラウザhook不可: DevTools Protocol経由で同等のbreakpoint/logを実装

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: DSL VM → `reverse-engineering` ; APK内WebView → `apk-reverse`
- 同级关联: `api-security` (HTTP sign検証), `reverse-engineering` (VM/難読化)

## 任務完了自検
1. 授权明記
2. js-reverse MCP / jshookmcp / Node の実パス検証
3. 署名定位 → hook → 補環境 → RPC → 検証 まで実行
4. DSL VMの場合は opcode/const table と dispatcher 対応表をfield-journalに蓄積
