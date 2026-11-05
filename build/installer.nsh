!include "LogicLib.nsh"

!macro customInstall
  ; Preserve user data across StoreFlow/Kasho upgrades.
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
  Delete "$DESKTOP\Kasho.lnk"
  Delete "$DESKTOP\كاشو.lnk"
  Delete "$SMPROGRAMS\Kasho\Kasho.lnk"
  Delete "$SMPROGRAMS\كاشو\كاشو.lnk"
  RMDir "$SMPROGRAMS\Kasho"
  RMDir "$SMPROGRAMS\كاشو"

  ; Optional full reset: deletes local database (including user accounts),
  ; remembered credentials and settings. Documents/Kasho/Backups is preserved.
  ${If} $LANGUAGE == 1025
    MessageBox MB_YESNO|MB_ICONQUESTION "هل تريد حذف بيانات Kasho بالكامل؟\nسيؤدي ذلك إلى حذف حسابات المستخدمين والمنتجات والمبيعات والإعدادات وبيانات تسجيل الدخول المحفوظة. لن تُحذف النسخ الاحتياطية الموجودة في المستندات." IDYES un_delete_kasho_data IDNO un_keep_kasho_data
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION "Delete all Kasho data?\nThis removes user accounts, products, sales, settings and remembered login details. Backups in Documents will be kept." IDYES un_delete_kasho_data IDNO un_keep_kasho_data
  ${EndIf}
un_delete_kasho_data:
  RMDir /r "$APPDATA\storeflow"
  RMDir /r "$APPDATA\Kasho"
  RMDir /r "$APPDATA\StoreFlow"
  Goto un_done_kasho_uninstall
un_keep_kasho_data:
un_done_kasho_uninstall:
!macroend
