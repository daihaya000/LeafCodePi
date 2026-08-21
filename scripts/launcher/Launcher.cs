// Native launcher for LeafCodePi.
//
// The compiled LeafCodePi.exe lives at the repository root and is the
// single entry point for the app (double-click / shortcut / taskbar pin).
// It is tracked in git so a fresh clone can start without building anything
// first; scripts\build-launcher.bat regenerates it from this source with the
// project icon embedded as a Win32 resource (csc.exe ships with the .NET
// Framework on Windows). Being a real .exe at a stable location is what lets
// Explorer reliably offer "Pin to taskbar" on a shortcut to it (this verb is
// inconsistent for shortcuts that target a .bat/.cmd script directly), and
// what makes Task Manager / Alt-Tab show a proper app name and icon instead
// of the generic "cmd.exe" / "Command Prompt" entry.
//
// It does not reimplement the setup/start logic: it sets the console title,
// then runs scripts\start-webui.bat (Node.js / dependency setup, then the
// tray host) via cmd.exe in the same console (no extra window, since a
// console-subsystem child inherits the parent's console when stdio is not
// redirected and no new console is requested) and forwards its exit code.
//
// Any failure that happens here, before scripts\start-webui.bat can run its
// own pause_if_interactive, pauses on Console.In.ReadLine() (see Fail())
// instead of exiting immediately, so a double-click launch's console window
// does not flash and close before the error message can be read.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

internal static class Launcher
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int infoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    // Kill-on-close job wrapping start-webui.bat. Closing the console or
    // TerminateProcess of this exe closes the handle and kills leftover
    // children that would otherwise keep an inherited listen socket.
    private static IntPtr TryCreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
        return job;
    }

    private static int Main()
    {
        try
        {
            Console.Title = "LeafCodePi";

            // The exe is committed at the repository root, so its own directory
            // is the repo root and the internal batch lives under scripts\.
            string repoRoot = AppDomain.CurrentDomain.BaseDirectory;
            string batPath = Path.Combine(repoRoot, "scripts", "start-webui.bat");

            if (!File.Exists(batPath))
            {
                Console.Error.WriteLine("scripts\\start-webui.bat not found at: " + batPath);
                // This exe is a thin entry point, not a standalone program: it
                // only works when kept inside a full clone of the repository
                // (scripts\, host\, web\ alongside it). Copying just the exe
                // elsewhere is the most common way to hit this, so say so
                // directly instead of leaving the user with a bare path.
                Console.Error.WriteLine(
                    "This exe only works from inside a full clone of the LeafCodePi " +
                    "repository (the scripts, host, and web folders must sit next to it). " +
                    "If you copied only LeafCodePi.exe somewhere else, re-clone the " +
                    "repository and run the exe from its root instead.");
                return Fail(1);
            }

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                // Prefix the quoted batch path with CALL. If the command passed to
                // cmd /c starts with a quote, cmd strips that quote pair before it
                // parses metacharacters. A repo path containing '&' then gets split
                // into separate commands and the launcher can exit without running
                // the batch file. CALL keeps the path's quotes intact while cmd
                // parses the command.
                Arguments = "/d /c call \"" + batPath + "\"",
                WorkingDirectory = repoRoot,
                UseShellExecute = false,
            };

            IntPtr job = TryCreateKillOnCloseJob();
            using (Process p = Process.Start(psi))
            {
                if (job != IntPtr.Zero && p != null)
                {
                    AssignProcessToJobObject(job, p.Handle);
                }
                p.WaitForExit();
                if (job != IntPtr.Zero)
                {
                    CloseHandle(job);
                    job = IntPtr.Zero;
                }
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            // Anything thrown above (e.g. Process.Start failing because
            // cmd.exe cannot be launched) would otherwise print a stack trace
            // and exit before a double-click launch's freshly created console
            // window can be read. Report it plainly and pause instead.
            Console.Error.WriteLine("LeafCodePi.exe failed to start: " + ex.Message);
            return Fail(1);
        }
    }

    /// <summary>
    /// Keeps the console window open on early failures - those that happen
    /// before scripts\start-webui.bat runs and can use its own
    /// pause_if_interactive - so a double-click launch does not just flash
    /// and close before the error above can be read. Set
    /// LEAFCODE_PI_NONINTERACTIVE=1 to skip waiting (same variable name
    /// and meaning as start-webui.bat's pause_if_interactive). Automated
    /// tests spawn this exe with stdin already closed/at EOF, so
    /// Console.In.ReadLine() returns immediately there and never blocks them.
    /// </summary>
    private static int Fail(int code)
    {
        string noninteractive = Environment.GetEnvironmentVariable("LEAFCODE_PI_NONINTERACTIVE");
        if (noninteractive != "1")
        {
            Console.Error.WriteLine("Press Enter to close this window...");
            Console.In.ReadLine();
        }
        return code;
    }
}
