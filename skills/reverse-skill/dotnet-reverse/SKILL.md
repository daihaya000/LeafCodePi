---
name: dotnet-reverse
description: >
  .NET/C#マネージドPEリバースエンジニアリング。 Trigger on .net reverse,
  c# decompile, dotnet, dnspy, de4dot, ilspy, 脱壳, assembly patch,
  Sharp* redteam tools.
---

# .NET Reverse

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `identify(dnSpyEx)` を実行

## 適用範囲
- .NET Framework / .NET Core / C# 託管PE逆向
- 逆コンパイル (dnSpyEx, ILSpy) とIL修正 (dnlib)
- 主要難読化ツール対応 (ConfuserEx, Eazfuscator, Dotfuscator, Agil.NET)
- de4dotによる自動脱混淆・dump
- Sharp* 系赤隊ツールの解析・改変
- assembly load / AppDomain / reflection 追跡

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| dnSpyEx | yes | GUI debugger/decompiler | false |
| ILSpy | yes | IL→C# decompile | false |
| de4dot | yes | deobfuscator / unpacker | false |
| dnlib | yes | IL編集ライブラリ | true |
| .NET SDK | yes | build/ildasm | true |
| PowerShell / CMD | yes | execute / patch scripts | true |

## 工作流
1. **identify(dnSpyEx)**: PEを開き target framework と entry point を確認
   - `C:\Tools\dnSpyEx\dnSpy.exe target.exe`
2. **deobfuscate(de4dot)**: 難読化検出時にまず脱混淆
   ```powershell
   de4dot.exe -r c:\samples -ro c:\samples\unpacked
   ```
   - 失敗時は `--dont-rename` や手動 `dynamic` approach (dnSpyEx debugger)
3. **逆コンパイル(ILSpy)**: IL → C# でロジック読解
   - delegate / LINQ / async state machine に注意
4. **解析**: 暗号・network・registry・D/Invoke・syscalls箇所を特定
5. **パッチ(dnlib)**: ILをプログラムで改変
   ```csharp
   var mod = ModuleDefMD.Load("target.dll");
   var method = mod.Types[0].Methods[0];
   method.Body.Instructions[0] = OpCodes.Ldc_I4_1; // true
   mod.Write("patched.dll");
   ```
6. **debug/検証**: dnSpyEx debugger で patch後の動作確認
7. **Sharp* assembly load追跡**: AppDomain.AssemblyResolve / reflection load をログ化

## 常用難読化対応
| obfuscator | method |
|------------|--------|
| ConfuserEx | de4dot, then manual anti-tamper fix |
| Eazfuscator | de4dot-eazfix or dynamic decryption |
| Dotfuscator | rename mapping, keep logic flow |
| Agil.NET | unpack with dnSpyEx + `Assembly.Load` dump |

## 按需自举
- dnSpyEx/ILSpy/de4dot不在: 手動ダウンロード。`tool-index.md` に実パス登録
- dnlib不在: `pip install dnlib` (Python wrapper) または NuGetで `dnlib.dll` 取得
- .NET SDK不在: `winget install Microsoft.DotNet.SDK.8`

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: native COM/PE部分 → `ida-reverse` / `radare2` ; 游戏IL2CPP → `reverse-engineering`
- 同级关联: `ida-reverse` (native PE), `reverse-engineering` (packed/VM), `malware-analysis`

## 任務完了自検
1. 授权明記
2. dnSpyEx/ILSpy/de4dot/dnlib の実パスを `tool-index.md` で検証
3. identify → deobfuscate → decompile → 解析 → patch → debug まで実行
4. `field-journal/precedent-reverse.md` に難読化種別と復元手法をanonymizeして蓄積
