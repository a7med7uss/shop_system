!include "LogicLib.nsh"

!macro customInstall
  ; Preserve the previous data directory during the StoreFlow -> Kasho upgrade.
  CreateDirectory "$APPDATA\storeflow"
  Delete "$DESKTOP\StoreFlow.lnk"
  Delete "$DESKTOP\Kasho.lnk"
  Delete "$DESKTOP\كاشو.lnk"
  RMDir /r "$SMPROGRAMS\StoreFlow"
  RMDir /r "$SMPROGRAMS\Kasho"
  RMDir /r "$SMPROGRAMS\كاشو"

  ${If} $LANGUAGE == 1025
    FileOpen $0 "$APPDATA\storeflow\install-language.txt" w
    FileWrite $0 "ar"
    FileClose $0
    CreateDirectory "$SMPROGRAMS\كاشو"
    CreateShortCut "$DESKTOP\كاشو.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    CreateShortCut "$SMPROGRAMS\كاشو\كاشو.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${Else}
    FileOpen $0 "$APPDATA\storeflow\install-language.txt" w
    FileWrite $0 "en"
    FileClose $0
    CreateDirectory "$SMPROGRAMS\Kasho"
    CreateShortCut "$DESKTOP\Kasho.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    CreateShortCut "$SMPROGRAMS\Kasho\Kasho.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$DESKTOP\\Kasho.lnk"
  Delete "$DESKTOP\\كاشو.lnk"
  Delete "$SMPROGRAMS\\Kasho\\Kasho.lnk"
  Delete "$SMPROGRAMS\\كاشو\\كاشو.lnk"
  RMDir "$SMPROGRAMS\\Kasho"
  RMDir "$SMPROGRAMS\\كاشو"
  ; Deliberately do not delete $APPDATA\\storeflow (user database/backups).
!macroend
