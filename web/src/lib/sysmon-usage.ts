import { execFile } from "node:child_process";
import os from "node:os";
import {
  cpuUsedPercent,
  parseAmdGpuJson,
  parseCpuTemperatureJson,
  parseNvidiaSmiCsv,
  sampleFromOscpus,
  type GpuMetric,
  type SystemUsage,
} from "@/lib/sysmon";

/** execFile を Promise 化。実 execFile は cb(err, stdout, stderr) で解決する。 */
function execFileAsync(
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

/** CPU サンプル間隔。GPU 取得と並行して寝てから2回目を取る。 */
const CPU_SAMPLE_GAP_MS = 250;

/** NVidia ドライバの nvidia-smi がインストール済みか（env で上書き可能）。 */
function nvidiaSmiBin(): string {
  return process.env.LEAFCODE_SYSMON_NVIDIA_SMI?.trim() || "nvidia-smi";
}

function powershellBin(): string {
  return process.env.LEAFCODE_SYSMON_POWERSHELL?.trim() || "powershell.exe";
}

/** Windows標準・既存モニター・AMD CPUMetricsServer v1.1 の CPU温度を読む。 */
const CPU_TEMPERATURE_QUERY = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$temperatureRecords = @()

# AMD CPUMetricsServer が公開する既知の v1.1 レイアウトだけを読み取る。
# 共有メモリが無い、番号が未知、温度が範囲外なら空文字を返す。
try {
  Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class LeafAmdCpuMetricsV11
{
  private const uint FileMapRead = 0x0004;
  private const int LayoutVersionOffset = 0x08;
  private const int TemperatureOffset = 0x1d8;
  private const int LayoutVersion = 0x00000101;
  private const string MappingName = "954b280e-5529-4492-bab2-bb7a502552f8";

  [DllImport("kernel32.dll", EntryPoint = "OpenFileMappingW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr OpenFileMapping(uint desiredAccess, bool inheritHandle, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr MapViewOfFile(IntPtr mapping, uint desiredAccess, uint offsetHigh, uint offsetLow, UIntPtr bytesToMap);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool UnmapViewOfFile(IntPtr view);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  public static string Read()
  {
    IntPtr mapping = OpenFileMapping(FileMapRead, false, MappingName);
    if (mapping == IntPtr.Zero) return "";
    IntPtr view = IntPtr.Zero;
    try
    {
      view = MapViewOfFile(mapping, FileMapRead, 0, 0, UIntPtr.Zero);
      if (view == IntPtr.Zero) return "";
      if (Marshal.ReadInt32(view, LayoutVersionOffset) != LayoutVersion) return "";
      double temperature = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(view, TemperatureOffset));
      if (Double.IsNaN(temperature) || Double.IsInfinity(temperature) || temperature < -50 || temperature > 150) return "";
      return "{\"provider\":\"amd-cpumetrics\",\"version\":" +
        LayoutVersion.ToString(CultureInfo.InvariantCulture) +
        ",\"tempC\":" + temperature.ToString("R", CultureInfo.InvariantCulture) + "}";
    }
    finally
    {
      if (view != IntPtr.Zero) UnmapViewOfFile(view);
      CloseHandle(mapping);
    }
  }
}
'@
  $amdRecord = [LeafAmdCpuMetricsV11]::Read()
  if (-not [string]::IsNullOrWhiteSpace($amdRecord)) {
    $temperatureRecords += ConvertFrom-Json -InputObject $amdRecord
  }
} catch {
  # AMDソフトウェアが無い、または未知のレイアウトなら従来の取得経路を使う。
}

function Add-Temperature([double] $value) {
  if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return }
  if ($value -ge -50 -and $value -le 150) {
    $script:temperatureRecords += [pscustomobject]@{ tempC = $value }
  }
}

# OpenHardwareMonitor / LibreHardwareMonitor は値を℃で返す。
foreach ($namespace in @('root\LibreHardwareMonitor', 'root\OpenHardwareMonitor')) {
  foreach ($sensor in @(Get-CimInstance -Namespace $namespace -Class Sensor |
      Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'CPU|Package|Tctl|Tdie|Core' })) {
    Add-Temperature ([double] $sensor.Value)
  }
}

# Intel/BIOS の標準 CIM 温度センサーは CurrentReading が 1/10℃。
foreach ($sensor in @(Get-CimInstance -Namespace 'root\cimv2' -ClassName CIM_TemperatureSensor |
    Where-Object { $_.Name -match 'CPU|Package|Processor|Core|Socket|Die|Tctl|Tdie' })) {
  $raw = [double] $sensor.CurrentReading
  if ($raw -gt 0) { Add-Temperature ($raw / 10) }
}

# ACPI / Windows thermal-zone の値は 1/10 K。
foreach ($zone in @(Get-CimInstance -Namespace 'root\wmi' -Class MSAcpi_ThermalZoneTemperature)) {
  Add-Temperature (([double] $zone.CurrentTemperature / 10) - 273.15)
}
foreach ($zone in @(Get-CimInstance -Namespace 'root\cimv2' -Class Win32_PerfFormattedData_Counters_ThermalZoneInformation)) {
  $raw = [double] $zone.HighPrecisionTemperature
  if ($raw -le 0) { $raw = [double] $zone.Temperature }
  if ($raw -gt 0) { Add-Temperature (($raw / 10) - 273.15) }
}

if ($temperatureRecords.Count -eq 0) {
  [pscustomobject]@{ tempC = $null } | ConvertTo-Json -Compress
} else {
  ConvertTo-Json -InputObject $temperatureRecords -Compress
}
`.trim();

async function collectCpuTemperature(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      powershellBin(),
      ["-NoProfile", "-NonInteractive", "-Command", CPU_TEMPERATURE_QUERY],
      { timeout: 4000, windowsHide: true },
    );
    return parseCpuTemperatureJson(stdout);
  } catch {
    return null;
  }
}

/**
 * Windows標準のGPUパフォーマンスカウンターをAMD用に正規化するスクリプト。
 * GPU Engine はLUID単位で最大エンジン使用率を取り、VRAMはDedicated Usageを
 * 使う。他ベンダーGPUとの混在時はLUIDを自動推測せず、環境変数で明示できる。
 */
const AMD_GPU_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
function Get-LuidKey([string] $name) {
  if ($name -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_') {
    $raw = $Matches[1]
  } elseif ($name -match '^(0x[0-9a-f]+_0x[0-9a-f]+)$') {
    $raw = $Matches[1]
  } else {
    return $null
  }
  # カウンター名は0埋め（0x00000000_0x00022e5d）だが D3DKMT 側は無埋めの
  # ため、数値へ解析してから再フォーマットし、両側のキーを一致させる。
  $parts = $raw -split '_'
  return ('0x{0:x}_0x{1:x}' -f [uint64]$parts[0], [uint64]$parts[1])
}

function Get-VramTotal([string] $adapterName) {
  # AdapterRAM は 32bit のため 4GB で切り捨てられる（VRAM32GB でも 4GB と誤る）。
  # レジストリの qwMemorySize（64bit）から正しい総量を取る。同名は最大値を採用。
  $total = $null
  $classKeyName = 'SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  $classHive = [Microsoft.Win32.Registry]::LocalMachine
  try {
    $classRoot = $classHive.OpenSubKey($classKeyName)
    if ($null -ne $classRoot) {
      foreach ($sub in $classRoot.GetSubKeyNames()) {
        if ($sub -notmatch '^\d+$') { continue }
        try {
          $inst = $classRoot.OpenSubKey($sub)
          if ($null -ne $inst) {
            if ($inst.GetValue('DriverDesc') -eq $adapterName) {
              $qw = $inst.GetValue('HardwareInformation.qwMemorySize')
              if ($null -ne $qw) {
                $v = [double] $qw
                if ($null -eq $total -or $v -gt $total) { $total = $v }
              }
            }
            $inst.Dispose()
          }
        } catch { /* 読み取り不可キーは無視 */ }
      }
      $classRoot.Dispose()
    }
  } catch { /* レジストリ読取不可なら呼び出し側で AdapterRAM へフォールバック */ }
  return $total
}

$override = $env:LEAFCODE_SYSMON_AMD_LUID

# GPU温度は ADL（Radeon 新世代は拒否）や WMI では取れないため、
# D3DKMTQueryAdapterInfo（KMTQAITYPE_ADAPTERPERFDATA）でベンダー非依存に読む。
# Temperature は1/10℃単位。LUID単位で取得し、カウンターの LUID と突合する。
$tempByLuid = @{}
$tempMaxByLuid = @{}
try {
  Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
public static class LeafGpuTemp {
  [StructLayout(LayoutKind.Sequential)]
  public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ADAPTERINFO { public uint hAdapter; public LUID AdapterLuid; public uint NumOfSources; public uint bPrecisePresentRegionsPreferred; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ENUMADAPTERS2 { public uint NumAdapters; public IntPtr pAdapters; }
  [StructLayout(LayoutKind.Sequential)]
  public struct QUERYADAPTERINFO { public uint hAdapter; public int Type; public IntPtr pPrivateDriverData; public int PrivateDriverDataSize; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PERFDATA { public uint PhysicalAdapterIndex; public ulong MemoryFrequency; public ulong MaxMemoryFrequency; public ulong MaxMemoryFrequencyOC; public ulong MemoryBandwidth; public ulong PCIEBandwidth; public uint FanRPM; public uint Power; public uint Temperature; public byte PowerStateOverride; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PERFDATACAPS { public uint PhysicalAdapterIndex; public ulong MaxMemoryBandwidth; public ulong MaxPCIEBandwidth; public uint MaxFanRPM; public uint TemperatureMax; public uint TemperatureWarning; }

  [DllImport("gdi32.dll")] public static extern int D3DKMTEnumAdapters2(ref ENUMADAPTERS2 p);
  [DllImport("gdi32.dll")] public static extern int D3DKMTQueryAdapterInfo(ref QUERYADAPTERINFO p);

  public static string Read() {
    ENUMADAPTERS2 ea = new ENUMADAPTERS2();
    if (D3DKMTEnumAdapters2(ref ea) != 0) return "";
    int aiSize = Marshal.SizeOf(typeof(ADAPTERINFO));
    int pdSize = Marshal.SizeOf(typeof(PERFDATA));
    int cpSize = Marshal.SizeOf(typeof(PERFDATACAPS));
    ea.pAdapters = Marshal.AllocHGlobal(aiSize * (int)ea.NumAdapters);
    string result = "";
    try {
      if (D3DKMTEnumAdapters2(ref ea) != 0) return "";
      IntPtr pb = Marshal.AllocHGlobal(pdSize);
      IntPtr cb = Marshal.AllocHGlobal(cpSize);
      try {
        for (int i = 0; i < (int)ea.NumAdapters; i++) {
          ADAPTERINFO ai = (ADAPTERINFO)Marshal.PtrToStructure(IntPtr.Add(ea.pAdapters, i * aiSize), typeof(ADAPTERINFO));
          PERFDATA pd = new PERFDATA();
          pd.PhysicalAdapterIndex = 0;
          Marshal.StructureToPtr(pd, pb, false);
          QUERYADAPTERINFO qa = new QUERYADAPTERINFO();
          qa.hAdapter = ai.hAdapter;
          qa.Type = 62; // KMTQAITYPE_ADAPTERPERFDATA
          qa.pPrivateDriverData = pb;
          qa.PrivateDriverDataSize = pdSize;
          if (D3DKMTQueryAdapterInfo(ref qa) != 0) continue;
          pd = (PERFDATA)Marshal.PtrToStructure(pb, typeof(PERFDATA));
          if (pd.Temperature == 0) continue;
          string key = ("0x" + ai.AdapterLuid.HighPart.ToString("x") + "_0x" + ai.AdapterLuid.LowPart.ToString("x")).ToLowerInvariant();
          PERFDATACAPS caps = new PERFDATACAPS();
          caps.PhysicalAdapterIndex = 0;
          Marshal.StructureToPtr(caps, cb, false);
          qa.Type = 63; // KMTQAITYPE_ADAPTERPERFDATA_CAPS
          qa.pPrivateDriverData = cb;
          qa.PrivateDriverDataSize = cpSize;
          uint max = 0;
          if (D3DKMTQueryAdapterInfo(ref qa) == 0) {
            caps = (PERFDATACAPS)Marshal.PtrToStructure(cb, typeof(PERFDATACAPS));
            max = caps.TemperatureMax;
          }
          result += key + "=" + (pd.Temperature / 10.0).ToString(CultureInfo.InvariantCulture) + "/" + max.ToString(CultureInfo.InvariantCulture) + ";";
        }
      } finally {
        Marshal.FreeHGlobal(pb);
        Marshal.FreeHGlobal(cb);
      }
    } finally {
      Marshal.FreeHGlobal(ea.pAdapters);
    }
    return result;
  }
}
'@
  foreach ($entry in ([LeafGpuTemp]::Read() -split ';')) {
    if ($entry -match '^(0x[0-9a-f]+_0x[0-9a-f]+)=([0-9.]+)/([0-9]+)$') {
      $k = Get-LuidKey $Matches[1]
      if ($null -ne $k) {
        $tempByLuid[$k] = [double] $Matches[2]
        if ([double] $Matches[3] -gt 0) { $tempMaxByLuid[$k] = [double] $Matches[3] }
      }
    }
  }
} catch {
  # 温度取得に失敗しても使用率/VRAMは返す
}

$physical = @(Get-CimInstance Win32_VideoController |
  Where-Object { $_.Name -notmatch 'Virtual|Remote|Basic|Parsec' })
$amd = @($physical | Where-Object { $_.Name -match 'AMD|Radeon' })
if ($amd.Count -eq 0) {
  [pscustomobject]@{ available = $false; reason = 'AMD GPU が見つかりません' } | ConvertTo-Json -Compress
  exit
}
# LUID 指定が必要なのは「AMD 以外の物理カード（NVIDIA/Intel 等）と共存し、
# 自動選択が他カードのカウンターを誤選択し得る」場合だけ。AMD のみなら
# 全カウンターが AMD なので自動選択で安全。
$needLuid = @($physical | Where-Object { $_.Name -notmatch 'AMD|Radeon' }).Count -gt 0

$overrideKey = Get-LuidKey $override
if ($needLuid -and [string]::IsNullOrWhiteSpace($overrideKey)) {
  [pscustomobject]@{ available = $false; reason = 'NVIDIA等の他GPUと共存するためLEAFCODE_SYSMON_AMD_LUIDを指定してください' } | ConvertTo-Json -Compress
  exit
}

$memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory)
$engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)
$engineByLuid = @{}
foreach ($engine in $engines) {
  $key = Get-LuidKey ([string] $engine.Name)
  if ($null -eq $key) { continue }
  $value = [double] $engine.UtilizationPercentage
  if (!$engineByLuid.ContainsKey($key) -or $value -gt $engineByLuid[$key]) {
    $engineByLuid[$key] = $value
  }
}

# AMD アダプターを VRAM 総量の大きい順に並べる（dGPU が先、iGPU が後）。
$adapters = @()
foreach ($a in $amd) {
  $total = Get-VramTotal ([string] $a.Name)
  if ($null -eq $total -and $null -ne $a.AdapterRAM) { $total = [double] $a.AdapterRAM }
  $adapters += [pscustomobject]@{
    name = [string] $a.Name
    total = $total
  }
}
$adapters = @($adapters | Sort-Object @{ Expression = { [double] $_.total }; Descending = $true })

# カウンター側も VRAM 使用量の多い LUID から並べ、同名アダプターと大きい順に対応付ける。
$selectedKeys = @($memory | Sort-Object @{ Expression = { [double] $_.DedicatedUsage }; Descending = $true } | ForEach-Object { Get-LuidKey ([string] $_.Name) } | Where-Object { $null -ne $_ })
if ($overrideKey) {
  # 明示指定があれば、その LUID に絞る（AMD のみ構成で古い LUID 等でもフォールバックで全列挙）。
  $hit = @($memory | Where-Object { (Get-LuidKey ([string] $_.Name)) -eq $overrideKey })
  if ($hit.Count -gt 0) { $selectedKeys = @($overrideKey) }
}
if ($selectedKeys.Count -eq 0) {
  [pscustomobject]@{ available = $false; reason = 'AMD GPUのパフォーマンスカウンターを取得できません' } | ConvertTo-Json -Compress
  exit
}

$result = @()
# LUID 数が AMD アダプター数より多い場合（仮想アダプター等）は、対応付けできない分を切り捨てる。
$limit = [Math]::Min($selectedKeys.Count, $adapters.Count)
for ($i = 0; $i -lt $limit; $i++) {
  $key = $selectedKeys[$i]
  $m = $memory | Where-Object { (Get-LuidKey ([string] $_.Name)) -eq $key } | Select-Object -First 1
  if ($null -eq $m) { continue }
  # LUID とアダプター名の直接対応は Windows カウンターに無いため、VRAM 使用量順 ↔ 総量順で対応付ける。
  $adapter = $adapters[$i]
  $gpu = [double] 0
  if ($engineByLuid.ContainsKey($key)) { $gpu = [double] $engineByLuid[$key] }
  $total = $null
  if ($null -ne $adapter.total) { $total = [double] $adapter.total }
  $tempC = $null
  if ($tempByLuid.ContainsKey($key)) { $tempC = [double] $tempByLuid[$key] }
  $tempMaxC = $null
  if ($tempMaxByLuid.ContainsKey($key)) { $tempMaxC = [double] $tempMaxByLuid[$key] }
  $result += [pscustomobject]@{
    available = $true
    name = $adapter.name
    usedPercent = $gpu
    dedicatedUsedBytes = [double] $m.DedicatedUsage
    vramTotalBytes = $total
    tempC = $tempC
    tempMaxC = $tempMaxC
  }
}
$result | ConvertTo-Json -Compress
`.trim();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** NVidia の使用率・VRAMを取得する。 */
async function collectNvidiaGpu(): Promise<GpuMetric | null> {
  try {
    const { stdout } = await execFileAsync(
      nvidiaSmiBin(),
      [
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
      ],
      // PC 起動直後の初回 spawn はドライバ初期化で遅くなることがある。
      { timeout: 6000, windowsHide: true },
    );
    const parsed = parseNvidiaSmiCsv(stdout);
    if (!parsed) return null;
    const vramUsedPercent =
      parsed.vramTotalBytes > 0
        ? (parsed.vramUsedBytes / parsed.vramTotalBytes) * 100
        : null;
    return {
      available: true,
      name: parsed.name,
      usedPercent: parsed.usedPercent,
      vramUsedPercent,
      vramUsedBytes: parsed.vramUsedBytes,
      vramTotalBytes: parsed.vramTotalBytes,
      tempC: parsed.tempC,
      tempMaxC: null,
      reason: null,
    };
  } catch {
    return null;
  }
}

/** Windows標準カウンター経由でAMDの使用率・VRAMを取得する。複数GPU（dGPU/iGPU）を返す。 */
async function collectAmdGpu(): Promise<GpuMetric[]> {
  try {
    const { stdout } = await execFileAsync(
      powershellBin(),
      ["-NoProfile", "-NonInteractive", "-Command", AMD_GPU_QUERY],
      // Add-Type コンパイル + WMI 列挙は PC 起動直後のコールドスタートで
      // 10 秒超えることがあるため余裕を持たせる。
      { timeout: 15000, windowsHide: true },
    );
    return parseAmdGpuJson(stdout).map((parsed) => {
      const vramUsedPercent =
        parsed.vramTotalBytes !== null && parsed.vramTotalBytes > 0
          ? (parsed.vramUsedBytes / parsed.vramTotalBytes) * 100
          : null;
      return {
        available: true,
        name: parsed.name,
        usedPercent: parsed.usedPercent,
        vramUsedPercent,
        vramUsedBytes: parsed.vramUsedBytes,
        vramTotalBytes: parsed.vramTotalBytes,
        tempC: parsed.tempC,
        tempMaxC: parsed.tempMaxC,
        reason: null,
      };
    });
  } catch {
    return [];
  }
}

/**
 * GPU収集の直近成功値（フェイルオーバー用）。
 * PowerShell + Add-Type + WMI は一時的にタイムアウト／空応答することがあり、
 * そのたび gpus: [] を返すとウィジェットのGPU行が一瞬消えて点滅する。
 * 取得失敗時は直近の成功値（TTL内）で補完する。テストは
 * LEAFCODE_SYSMON_GPU_CACHE_MS=0 で無効化できる。
 */
const GPU_STALE_FALLBACK_MS = 30_000;

function gpuFallbackTtlMs(): number {
  const raw = Number(process.env.LEAFCODE_SYSMON_GPU_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : GPU_STALE_FALLBACK_MS;
}

let lastNvidiaGpu: { value: GpuMetric; at: number } | null = null;
let lastAmdGpus: { value: GpuMetric[]; at: number } | null = null;

/**
/**
 * GPU使用率・VRAMを取得する。NVidia と AMD を並列で試し、見つかったものを全部返す。
 * 一時的な取得失敗では直近の成功値にフォールバックし、表示の点滅を防ぐ。
 */
async function collectGpusOnce(): Promise<GpuMetric[]> {
  const requestedAt = Date.now();
  const [nvidia, amd] = await Promise.all([collectNvidiaGpu(), collectAmdGpu()]);
  if (nvidia) lastNvidiaGpu = { value: nvidia, at: requestedAt };
  if (amd.length > 0) lastAmdGpus = { value: amd, at: requestedAt };

  const ttl = gpuFallbackTtlMs();
  const nvidiaOut =
    nvidia ??
    (lastNvidiaGpu !== null && ttl > 0 && requestedAt - lastNvidiaGpu.at < ttl
      ? lastNvidiaGpu.value
      : null);
  const amdOut =
    amd.length > 0
      ? amd
      : lastAmdGpus !== null && ttl > 0 && requestedAt - lastAmdGpus.at < ttl
        ? lastAmdGpus.value
        : [];
  return [...(nvidiaOut ? [nvidiaOut] : []), ...amdOut];
}

/**
 * 空結果のときだけ一度再試行する。PC / サーバ起動直後の最初の spawn は
 * nvidia-smi や PowerShell (Add-Type コンパイル) がタイムアウトしやすく、
 * その場合 stale フォールバックも初回成功前なので GPU が欠けたままになる。
 * 2回目はバイナリが温まっているため成功しやすい。
 */
async function collectGpus(): Promise<GpuMetric[]> {
  const first = await collectGpusOnce();
  if (first.length > 0) return first;
  return collectGpusOnce();
}

/**
 * Collect CPU / memory / GPU usage for GET /api/sysmon/usage.
 * Always succeeds with `available: true` for host metrics; GPU may be empty.
 */
export async function collectSystemUsage(): Promise<SystemUsage> {
  // CPU使用率は2サンプル間で定義される。GPU取得(子プロセス)と並行して
  // サンプル間隔を取り、追加コストを最小化する（NVidia外では待機のみで代替）。
  const prev = sampleFromOscpus(os.cpus());
  const [gpus, tempC] = await Promise.all([
    collectGpus(),
    collectCpuTemperature(),
    sleep(CPU_SAMPLE_GAP_MS),
  ]);
  const curr = sampleFromOscpus(os.cpus());

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const usedPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

  return {
    available: true,
    reason: null,
    schema: "sysmon.usage/v1",
    generatedAt: new Date().toISOString(),
    cpu: {
      usedPercent: cpuUsedPercent(prev, curr),
      cores: os.cpus().length,
      model: os.cpus()[0]?.model ?? "—",
      tempC,
    },
    memory: {
      usedPercent: Math.round(usedPercent * 10) / 10,
      usedBytes: usedMem,
      totalBytes: totalMem,
    },
    gpus,
  };
}

/**
 * Short TTL + single-flight around collectSystemUsage.
 * nvidia-smi / PowerShell WMI are expensive; without this, an 8–15s client poll
 * still re-spawns children on every request and contends with the chat BFF.
 */
const USAGE_CACHE_DEFAULT_MS = 3_000;

function usageCacheTtlMs(): number {
  const raw = Number(process.env.LEAFCODE_SYSMON_USAGE_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : USAGE_CACHE_DEFAULT_MS;
}

let usageCache: {
  value: SystemUsage;
  at: number;
} | null = null;
let usageInflight: Promise<SystemUsage> | null = null;

/** Test helper — drop the aggregate usage cache. */
export function resetSystemUsageCacheForTests(): void {
  usageCache = null;
  usageInflight = null;
}

export async function collectSystemUsageCached(): Promise<SystemUsage> {
  const ttl = usageCacheTtlMs();
  const now = Date.now();
  if (ttl > 0 && usageCache && now - usageCache.at < ttl) {
    return usageCache.value;
  }
  if (usageInflight) return usageInflight;

  usageInflight = collectSystemUsage()
    .then((value) => {
      usageCache = { value, at: Date.now() };
      usageInflight = null;
      return value;
    })
    .catch((error) => {
      usageInflight = null;
      throw error;
    });
  return usageInflight;
}
