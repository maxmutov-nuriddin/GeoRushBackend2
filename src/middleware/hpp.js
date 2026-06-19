// HTTP Parameter Pollution (HPP) himoyasi.
// `?limit=5&limit=999` kabi takroriy query-param Express'da MASSIV (['5','999']) bo'ladi.
// Controllerlar query'ni skalar deb kutadi (parseInt, isIn, ===) — massiv kelsa validator
// chetlab o'tilishi yoki kutilmagan xulq yuz berishi mumkin. Bu yerda har bir takroriy
// query-param OXIRGI qiymatga keltiriladi (standart `hpp` xulqi bilan bir xil).
// Eslatma: loyihadagi BARCHA query kalitlari skalar (limit, page, scope, apply) — massiv
// kutadigan endpoint yo'q, shuning uchun bu hech bir ishlaydigan oqimni buzmaydi.
function hppGuard(req, _res, next) {
  const q = req.query;
  if (q && typeof q === 'object') {
    for (const key of Object.keys(q)) {
      if (Array.isArray(q[key])) {
        q[key] = q[key][q[key].length - 1];
      }
    }
  }
  next();
}

module.exports = { hppGuard };
