const { Schema, model } = require('mongoose');

const otpSessionSchema = new Schema({
  token:    { type: String, required: true, unique: true },
  phone:    { type: String, required: true },
  otp:      { type: String, default: null },     // bot yuborguncha saqlanadi, keyin null
  otpHash:  { type: String, default: null },     // bot yuborgandan keyin SHA-256 hash
  chatId:   { type: Number, default: null },
  otpSent:  { type: Boolean, default: false },
  verified: { type: Boolean, default: false },
  purpose:  { type: String, enum: ['register', 'reset'], default: 'register' },
  expiresAt:{ type: Date, required: true },
}, { timestamps: true });

// MongoDB TTL — muddati o'tganlar avtomatik o'chadi
otpSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('OTPSession', otpSessionSchema);
