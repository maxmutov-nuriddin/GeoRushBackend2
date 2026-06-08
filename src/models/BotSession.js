const { Schema, model } = require('mongoose');

// Bot oqimlarini saqlash: server restart bo'lsa ham yo'qolmaydi
const botSessionSchema = new Schema({
  chatId:    { type: String, required: true, index: true },
  type:      { type: String, enum: ['pendingObuna', 'pendingReceipt'], required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

// TTL index — MongoDB o'zi o'chiradi
botSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// chatId + type juftligi unique
botSessionSchema.index({ chatId: 1, type: 1 }, { unique: true });

module.exports = model('BotSession', botSessionSchema);
