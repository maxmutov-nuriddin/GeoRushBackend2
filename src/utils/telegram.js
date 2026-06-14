// Telegram'ga yuboriladigan xabarlarda foydalanuvchi kiritgan matnni xavfsiz
// ko'rsatish uchun. Avval matn `parse_mode: 'Markdown'` bilan xom yuborilardi —
// bu ikki muammo tug'dirardi:
//   1) Buzuq Markdown (masalan, yakkalangan `*` yoki `[`) → Telegram API 400 qaytaradi
//      va xabar YO'QOLADI (support jamoasi murojaatni ko'rmaydi).
//   2) Inyeksiya: foydalanuvchi `[matn](http://soxta)` kabi havola/formatlash kiritib,
//      support kanaliga soxta kontent jo'natishi mumkin edi.
// Yechim: `parse_mode: 'HTML'` + dinamik (foydalanuvchi) qismlarni HTML-escape qilish.
// HTML mode'da faqat &, <, > belgilarini almashtirish kifoya.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { escapeHtml };
