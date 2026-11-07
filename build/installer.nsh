
!include "MUI2.nsh"

!define /ifndef MULTIUSER_EXECUTIONLEVEL Highest

!define MUI_WELCOMEFINISHPAGE_TITLE "Welcome to CilamAI"
!define MUI_WELCOMEFINISHPAGE_TEXT "CilamAI will be installed on your computer.\n\nA desktop and Start menu shortcut will be created. Click Next to continue, or Cancel to exit Setup."

!insertmacro MUI_PAGE_WELCOME
