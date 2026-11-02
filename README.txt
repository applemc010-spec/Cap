RustCut v2 — محرر فيديو متعدد المسارات (Rust + Tauri + FFmpeg)
================================================================

الحصول على ملف التثبيت (exe) بدون تثبيت أي شي على جهازك
1. أنشئ حساب مجاني على github.com ثم مستودع (Repository) جديد.
2. ارفع كل محتويات هذا المجلد (انتبه لمجلد .github المخفي).
3. Actions > build-windows > Run workflow.
4. بعد 15-30 دقيقة نزّل RustCut-installer من Artifacts وشغّل ملف setup.
   * خطوة whisper (الترجمة التلقائية) اختيارية: إذا فشلت يُبنى البرنامج بدونها،
     ويمكنك وضع whisper-cli.exe (+ DLLs) وملف ggml-base.bin يدوياً في: bin\whisper
   * SmartScreen قد يحذّر لأن البرنامج غير موقّع: More info > Run anyway.

البناء على جهازك
1. ثبّت Rust + Node.js 20 + Visual Studio Build Tools (C++).
2. ضع ffmpeg.exe في src-tauri\bin  (اختياري: whisper في src-tauri\bin\whisper)
3. npm install ; npx tauri icon app-icon.png ; npx tauri build
4. الناتج: src-tauri\target\release\bundle\nsis\*.exe
   للتجربة: npx tauri dev

المختصرات (F1 داخل البرنامج): Space تشغيل | S أو Ctrl+B تقسيم | + أو ] تسريع | - أو [ تبطيء
Delete حذف | Shift+Delete حذف مع إزاحة | Ctrl+D نسخ | Ctrl+Z/Y تراجع/إعادة | Ctrl+S حفظ | Ctrl+E تصدير
