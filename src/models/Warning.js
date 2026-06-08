const { Schema, model } = require('mongoose');

const warningSchema = new Schema({
  userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  adminId:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  reason:   { type: String, required: true, maxlength: 500 },
  severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
}, { timestamps: true });

warningSchema.index({ createdAt: -1 });

module.exports = model('Warning', warningSchema);
