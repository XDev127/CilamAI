// Windows pseudo-console (ConPTY) host for the integrated terminal.
//
// A piped PowerShell never looks like a terminal, so full-screen apps (opencode,
// vim, top, less) fall back to 80x24 and cannot receive raw keys. This module
// builds a PowerShell + C# shim that creates a ConPTY, launches the real shell
// inside it, and copies bytes between the pty and its own (piped) stdio. The
// pseudoconsole API and Add-Type both ship with Windows 10 1809+ and PowerShell,
// so this adds no npm dependency and no native rebuild step.
//
// The host's stdin is forwarded verbatim to the pty, so a resize travels as a
// whole-chunk text marker that the shim consumes instead of forwarding it.

export const RESIZE_PREFIX = "::CLMARESIZE::";

const CS = `
using SystemPLACEHOLDER;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class ClmaPty {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] struct SECATTR { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFOW {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEXW { public STARTUPINFOW si; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCINFO { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, int flags, out IntPtr hPC);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int ClosePseudoConsole(IntPtr hPC);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePipe(out IntPtr read, out IntPtr write, ref SECATTR sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int InitializeProcThreadAttributeList(IntPtr attr, int count, int flags, ref int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int UpdateProcThreadAttribute(IntPtr attr, int flags, IntPtr name, IntPtr value, IntPtr size, IntPtr prev, IntPtr outSize, IntPtr reserved);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern int CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, int inherit, int flags, IntPtr env, string dir, ref STARTUPINFOEXW si, out PROCINFO pi);
  const int ATTR_PSEUDOCONSOLE = 0x00020016;
  const int EXTENDED_STARTUPINFO = 0x00080000;
  public static string Start(string commandLine, int cols, int rows) {
    SECATTR sa = new SECATTR();
    sa.nLength = Marshal.SizeOf(typeof(SECATTR));
    IntPtr inRead, inWrite, outRead, outWrite;
    if (CreatePipe(out inRead, out inWrite, ref sa, 0) == 0) return "pipe:" + Marshal.GetLastWin32Error();
    if (CreatePipe(out outRead, out outWrite, ref sa, 0) == 0) return "pipe2:" + Marshal.GetLastWin32Error();
    COORD size = new COORD();
    size.X = (short)cols;
    size.Y = (short)rows;
    IntPtr hPC;
    if (CreatePseudoConsole(size, inRead, outWrite, 0, out hPC) != 0) return "pty:" + Marshal.GetLastWin32Error();
    int attrSize = 0;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    IntPtr list = Marshal.AllocHGlobal(attrSize);
    if (InitializeProcThreadAttributeList(list, 1, 0, ref attrSize) == 0) return "attrlist:" + Marshal.GetLastWin32Error();
    if (UpdateProcThreadAttribute(list, 0, (IntPtr)ATTR_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) == 0) return "attr:" + Marshal.GetLastWin32Error();
    STARTUPINFOEXW ex = new STARTUPINFOEXW();
    ex.si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
    ex.lpAttributeList = list;
    PROCINFO pi;
    if (CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, 0, EXTENDED_STARTUPINFO, IntPtr.Zero, null, ref ex, out pi) == 0) return "spawn:" + Marshal.GetLastWin32Error();
    CloseHandle(inRead);
    CloseHandle(outWrite);
    CloseHandle(pi.hThread);
    Stream stdin = Console.OpenStandardInput();
    Stream stdout = Console.OpenStandardOutput();
    Stream ptyIn = new FileStream(inWrite, FileAccess.Write);
    Stream ptyOut = new FileStream(outRead, FileAccess.Read);
    Thread pump = new Thread(delegate () {
      byte[] data = new byte[4096];
      try {
        int got;
        while ((got = stdin.Read(data, 0, data.Length)) > 0) {
          string text = System.Text.Encoding.UTF8.GetString(data, 0, got);
          if (text.StartsWith(REPLACE_PREFIX)) continue;
          ptyIn.Write(data, 0, got);
          ptyIn.Flush();
        }
      } catch {}
      try { ptyIn.Close(); } catch {}
    });
    pump.IsBackground = true;
    pump.Start();
    byte[] outBuf = new byte[65536];
    try {
      int read;
      while ((read = ptyOut.Read(outBuf, 0, outBuf.Length)) > 0) {
        stdout.Write(outBuf, 0, read);
        stdout.Flush();
      }
    } catch {}
    try { ClosePseudoConsole(hPC); } catch {}
    return null;
  }
}
`;

// PowerShell script that compiles the shim and runs the given command line
// inside a pseudo-console of the requested size.
export function hostScript(innerCommandLine, cols, rows) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "Add-Type -TypeDefinition @'",
    CS.trim(),
    "'@",
    "$result = [ClmaPty]::Start('" + innerCommandLine + "', " + Number(cols) + ", " + Number(rows) + ")",
    "if ($result) { Write-Output ('CLMAPTY-ERR: ' + $result); exit 3 }",
    "} catch {",
    "Write-Output ('CLMAPTY-ERR: ' + $_.Exception.Message)",
    "exit 3",
    "}",
  ];
  return lines.join("\r\n");
}

// Base64 UTF-16LE form for powershell.exe -EncodedCommand (no shell quoting).
export function encodedHostScript(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}
