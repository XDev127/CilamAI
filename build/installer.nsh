; CilamAI installer customization — included by electron-builder
; (build.nsis.include: "build/installer.nsh").
;
; electron-builder includes this file after Modern UI 2 is set up and before
; the default wizard pages, so pages inserted here appear at the start of
; the install flow.

!include "MUI2.nsh"

; makensis runs with cwd = node_modules/app-builder-lib/templates/nsis
; (see NsisTarget.executeMakensis). We do NOT !cd away from that directory:
; NSIS resolves relative !include directives against the current working
; directory, and the main installer.nsi template later does
; `!include "common.nsh"` (and friends) relative to templates\nsis. Changing
; cwd breaks those includes ("could not find: common.nsh"). Instead we keep
; cwd intact and reference our wizard bitmaps by absolute path below.

; electron-builder's multiUser.nsh template defines the setInstallModePerAllUsers
; macro but never sets MULTIUSER_EXECUTIONLEVEL, which NSIS' stock MultiUser.nsh
; requires (it emits `!warning "MULTIUSER_EXECUTIONLEVEL not set!"`, escalated to
; an error by makensis -WX). Defining it here (to any value) suppresses the
; warning without changing behavior because electron-builder's own RequestExecutionLevel
; directives in installer.nsi take precedence over stock MultiUser.nsh's.
; /ifndef makes this a no-op if electron-builder ever passes it on the command line.
!define /ifndef MULTIUSER_EXECUTIONLEVEL Highest

; --- Welcome page -----------------------------------------------------------
; Plain Modern UI 2 page — no header/sidebar bitmaps (kept out on purpose).
!define MUI_WELCOMEFINISHPAGE_TITLE "Welcome to CilamAI"
!define MUI_WELCOMEFINISHPAGE_TEXT "CilamAI will be installed on your computer.\n\nA desktop and Start menu shortcut will be created. Click Next to continue, or Cancel to exit Setup."

!insertmacro MUI_PAGE_WELCOME
