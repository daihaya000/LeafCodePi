import { describe, expect, it } from "vitest";
import {
  clampPercent,
  cpuUsedPercent,
  formatBytes,
  parseCpuTemperatureJson,
  parseAmdGpuJson,
  parseNvidiaSmiCsv,
  percentTone,
} from "./sysmon";

describe("clampPercent", () => {
  it("clamps below 0 and above 100, and normalizes NaN", () => {
    expect(clampPercent(-1)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42.4)).toBe(42.4);
    expect(clampPercent(null)).toBe(0);
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("percentTone", () => {
  it("uses ok <70 / warn <90 / danger >=90 thresholds", () => {
    expect(percentTone(0)).toBe("ok");
    expect(percentTone(69.9)).toBe("ok");
    expect(percentTone(70)).toBe("warn");
    expect(percentTone(89)).toBe("warn");
    expect(percentTone(90)).toBe("danger");
    expect(percentTone(100)).toBe("danger");
    expect(percentTone(null)).toBe("ok");
  });
});

describe("formatBytes", () => {
  it("formats bytes into convenient units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(8 * 1024 ** 2)).toBe("8.00 MB");
    expect(formatBytes(1515 * 1024 ** 2)).toContain("GB");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
  });
});

describe("cpuUsedPercent", () => {
  it("computes the average load across equal-length samples", () => {
    // Single core: idle unchanged, busy grew by 20 → 100% busy this window.
    const busyPrev = [{ idle: 80, total: 100 }];
    const busyCurr = [{ idle: 80, total: 120 }];
    expect(cpuUsedPercent(busyPrev, busyCurr)).toBeCloseTo(100, 5);

    // Two cores: core A gained +15 busy (idle grows 5), core B gained none
    // (idle grows 20) over a +20 total window each → (15+0)/(20+20) = 37.5%.
    expect(
      cpuUsedPercent(
        [
          { idle: 10, total: 100 },
          { idle: 5, total: 100 },
        ],
        [
          { idle: 15, total: 120 },
          { idle: 25, total: 120 },
        ],
      ),
    ).toBeCloseTo(37.5, 5);
  });

  it("returns null when idle drops are zero/non-positive (stale or equal samples)", () => {
    const prev = [{ idle: 10, total: 100 }];
    const curr = [{ idle: 10, total: 100 }];
    expect(cpuUsedPercent(prev, curr)).toBeNull();
    expect(cpuUsedPercent([], [{ idle: 1, total: 2 }])).toBeNull();
    expect(
      cpuUsedPercent([{ idle: 1, total: 2 }], [{ idle: 1, total: 2 }, { idle: 1, total: 2 }]),
    ).toBeNull();
  });
});

describe("parseCpuTemperatureJson", () => {
  it("uses the hottest valid CPU sensor value", () => {
    expect(
      parseCpuTemperatureJson('[{"tempC": 48.4}, {"tempC": 61.2}, {"tempC": null}]'),
    ).toBe(61.2);
    expect(parseCpuTemperatureJson('{"tempC": 54.6}')).toBe(54.6);
  });

  it("returns null for invalid or out-of-range values", () => {
    expect(parseCpuTemperatureJson("not json")).toBeNull();
    expect(parseCpuTemperatureJson('{"tempC": 180}')).toBeNull();
    expect(parseCpuTemperatureJson("[]")).toBeNull();
  });
});

describe("parseNvidiaSmiCsv", () => {
  it("parses a well-formed nvidia-smi csv line, converting MiB to bytes", () => {
    const parsed = parseNvidiaSmiCsv(
      "NVIDIA GeForce RTX 4060, 42, 1515, 8188",
    );
    expect(parsed).toEqual({
      name: "NVIDIA GeForce RTX 4060",
      usedPercent: 42,
      vramUsedBytes: 1515 * 1024 * 1024,
      vramTotalBytes: 8188 * 1024 * 1024,
      tempC: null,
    });
  });

  it("parses the optional temperature field and rejects [N/A]", () => {
    expect(parseNvidiaSmiCsv("RTX 4060, 42, 1515, 8188, 61")).toMatchObject({
      tempC: 61,
    });
    expect(parseNvidiaSmiCsv("RTX 4060, 42, 1515, 8188, [N/A]")).toMatchObject({
      tempC: null,
    });
  });

  it("returns null for empty or malformed input", () => {
    expect(parseNvidiaSmiCsv("")).toBeNull();
    expect(parseNvidiaSmiCsv("   ")).toBeNull();
    expect(parseNvidiaSmiCsv("only a name")).toBeNull();
    expect(parseNvidiaSmiCsv("name, abc, , 8")).toBeNull();
  });
});

describe("parseAmdGpuJson", () => {
  it("parses normalized Windows counter output with temperatures", () => {
    const parsed = parseAmdGpuJson(
      JSON.stringify([
        {
          available: true,
          name: "AMD Radeon AI PRO R9700",
          usedPercent: 37,
          dedicatedUsedBytes: 512 * 1024 ** 2,
          vramTotalBytes: 32 * 1024 ** 3,
          tempC: 48,
          tempMaxC: 110,
        },
        {
          available: true,
          name: "AMD Radeon(TM) Graphics",
          usedPercent: 5,
          dedicatedUsedBytes: 64 * 1024 ** 2,
          vramTotalBytes: 2 * 1024 ** 3,
          tempC: null,
          tempMaxC: 0,
        },
      ]),
    );
    expect(parsed).toEqual([
      {
        name: "AMD Radeon AI PRO R9700",
        usedPercent: 37,
        vramUsedBytes: 512 * 1024 ** 2,
        vramTotalBytes: 32 * 1024 ** 3,
        tempC: 48,
        tempMaxC: 110,
      },
      {
        name: "AMD Radeon(TM) Graphics",
        usedPercent: 5,
        vramUsedBytes: 64 * 1024 ** 2,
        vramTotalBytes: 2 * 1024 ** 3,
        tempC: null,
        tempMaxC: null,
      },
    ]);
  });

  it("accepts a single object and filters unavailable or malformed entries", () => {
    expect(parseAmdGpuJson(JSON.stringify({ available: true, name: "A", usedPercent: 1, dedicatedUsedBytes: 1 }))).toEqual([
      { name: "A", usedPercent: 1, vramUsedBytes: 1, vramTotalBytes: null, tempC: null, tempMaxC: null },
    ]);
    expect(parseAmdGpuJson(JSON.stringify({ available: false }))).toEqual([]);
    expect(parseAmdGpuJson(JSON.stringify([{ available: false }, { available: true, name: "B", usedPercent: 2, dedicatedUsedBytes: 2 }]))).toEqual([
      { name: "B", usedPercent: 2, vramUsedBytes: 2, vramTotalBytes: null, tempC: null, tempMaxC: null },
    ]);
    expect(parseAmdGpuJson("not json")).toEqual([]);
    expect(
      parseAmdGpuJson(
        JSON.stringify([
          {
            available: true,
            name: "AMD Radeon",
            usedPercent: 20,
            dedicatedUsedBytes: -1,
            vramTotalBytes: 1024,
          },
        ]),
      ),
    ).toEqual([]);
  });
});
