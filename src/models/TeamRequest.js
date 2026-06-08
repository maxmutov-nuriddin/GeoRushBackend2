const { Schema, model } = require('mongoose');

const teamRequestSchema = new Schema(
  {
    teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // 'request' = user → team (join request), 'invite' = team owner → user
    type: { type: String, enum: ['request', 'invite'], required: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
  },
  { timestamps: true },
);

teamRequestSchema.index({ teamId: 1, userId: 1, type: 1 });
teamRequestSchema.index({ userId: 1, status: 1 });

module.exports = model('TeamRequest', teamRequestSchema);
