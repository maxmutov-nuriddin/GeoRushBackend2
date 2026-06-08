const { Schema, model } = require('mongoose');

const antiCheatLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:   { type: String, required: true }, // 'speed', 'teleport', 'trail_gap', 'invalid_coords'
  reason: { type: String, default: '' },
  lat:    { type: Number, default: null },
  lng:    { type: Number, default: null },
  speed:  { type: Number, default: null }, // m/s
  count:  { type: Number, default: 1 },    // bitta "incident"dagi takror voqealar soni (spam'ni yig'ish)
}, { timestamps: true });

antiCheatLogSchema.index({ createdAt: -1 });
antiCheatLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }); // 7 kun TTL

module.exports = model('AntiCheatLog', antiCheatLogSchema);
