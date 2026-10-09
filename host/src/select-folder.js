import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
const run=promisify(execFile);
const SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'プロジェクトフォルダを選択'
$d.ShowNewFolderButton = $true
try { if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } }
finally { $d.Dispose() }
`.trim();
function refused(status,message){return Object.assign(new Error(message),{status});}
/** Host-only desktop interaction. No caller-selected command, options, initial path or environment. */
export async function selectProjectFolder({platform=process.platform,exec=run,statFile=stat}={}) {
 if(["next","backend"].includes(process.env.LEAFCODE_PI_PROCESS_ROLE))throw refused(503,"Folder selection is owned by Host");
 if(platform!=="win32")throw refused(400,"ネイティブ選択は Windows のみです");
 try {
  const encoded=Buffer.from(SCRIPT,"utf16le").toString("base64");
  const {stdout}=await exec("powershell.exe",["-NoProfile","-STA","-EncodedCommand",encoded],{timeout:120000,windowsHide:false,encoding:"utf8"});
  const path=stdout.trim();if(!path)return{cancelled:true};
  const info=await statFile(path).catch(()=>null);
  if(!info?.isDirectory())throw refused(400,"選択したパスはディレクトリではありません");
  return{path};
 } catch(error){if(error?.status===400)throw error;throw refused(503,"フォルダ選択の結果を確認できません");}
}
