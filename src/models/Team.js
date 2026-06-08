const { Schema, model } = require('mongoose');

const teamSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 100 },
    tag: { type: String, required: true, unique: true, trim: true, uppercase: true, maxlength: 10 },
    color: { type: String, default: '#ff6600', match: /^#[0-9A-Fa-f]{6}$/ },
    description: { type: String, default: '', maxlength: 500 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Jamoa metkalarini boshqara oladigan a'zolar (ega doim implitsit admin).
    // Egasi "adminlik" bera/olib tashlay oladi (Telegram-uslubidagi).
    markerAdmins: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    isPublic: { type: Boolean, default: true },
    totalArea: { type: Number, default: 0, min: 0 },
    memberCount: { type: Number, default: 0, min: 0 },
    wins: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

module.exports = model('Team', teamSchema);
