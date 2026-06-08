const { Schema, model } = require('mongoose');

// Jamoa metkasi (team marker) — jamoadagilarga ko'rinadigan, raqamlangan (order) nuqta.
// Faqat jamoa egasi yoki marker-admin qo'sha/o'chira oladi.
const teamMarkerSchema = new Schema(
  {
    teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true, index: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    label: { type: String, default: '', trim: true, maxlength: 80 },
    order: { type: Number, default: 1, min: 1 }, // markazda ko'rsatiladigan tartib raqami (1, 2, 3 …)
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

module.exports = model('TeamMarker', teamMarkerSchema);
