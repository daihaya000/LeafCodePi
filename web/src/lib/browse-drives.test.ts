import { describe, expect, it } from "vitest";
import { linuxDrivePaths, windowsDrivePaths } from "./browse-drives";

describe("linuxDrivePaths", () => {
  it("lists mounted external-volume locations, including escaped names, but not system paths", () => {
    const mountInfo = [
      "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
      "2 1 8:1 /etc /etc rw - ext4 /dev/sda1 rw",
      "3 1 8:2 / /mnt/External\\040SSD rw - ext4 /dev/sdb1 rw",
      "4 1 8:3 / /run/media/daichi/Backup rw - ext4 /dev/sdc1 rw",
      "5 1 8:4 / /media/daichi/Work rw - ext4 /dev/sdd1 rw",
      "6 1 8:5 / /mnt rw - ext4 /dev/sde1 rw",
      "7 1 8:5 / /mnt rw - ext4 /dev/sde1 rw",
    ].join("\n");
    expect(linuxDrivePaths(mountInfo)).toEqual([
      "/mnt/External SSD", "/run/media/daichi/Backup", "/media/daichi/Work", "/mnt",
    ]);
  });
});

describe("windowsDrivePaths", () => {
  it("accepts only local drive-letter roots", () => {
    expect(windowsDrivePaths("C:\\\r\nD:\\\r\nd:\\\r\n\\\\server\\share\r\nE:\\folder\r\n"))
      .toEqual(["C:\\", "D:\\"]);
  });
});
