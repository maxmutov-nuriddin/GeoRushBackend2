const { Schema, model } = require('mongoose');

const gameEventSchema = new Schema(
  {
    type: { type: String, required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    targetId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    territoryId: { type: Schema.Types.ObjectId, ref: 'Territory', default: null },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

gameEventSchema.index({ createdAt: -1 });
gameEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30 kun TTL

module.exports = model('GameEvent', gameEventSchema);
