# Precedent — 逆向関連

## 代表ケース
- APK解包 → Java逆コンパイル → smali修正 → .so解析 → Frida hook
- JS署名定位 → 補環境復元 → RPC呼出
- バイナリ静的解析（IDA/r2） → 動的検証（GDB/Frida） → アルゴリズム復元
- OLLVM脱混淆 → D-810/obpo-plugin → 制御フロー復元

## 共通教訓
- 静的→動的→静的の反復。一筋道で進めない
- ツール未インストール時はbootstrap呼出、パス推測禁止
- .so解析はAPKのdecode結果から、JSはobserveから入口を特定
- Windows desktop Ryzen はACPI/WMIの温度ソースが空になる場合がある。AMDの既存CPUMetrics共有メモリは読み取り候補だが、構造体・温度オフセットが未公開かつバージョン依存。Ryzen MasterドライバーのSMU/IOCTL直読みによる盲目的な実装は避ける。