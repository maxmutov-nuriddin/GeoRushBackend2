const { Schema, model } = require('mongoose');

const territorySchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    teamId: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
    // GeoJSON Polygon: { type: 'Polygon', coordinates: [[[lng,lat],...]] }
    polygon: {
      type: { type: String, enum: ['Polygon'], required: true, default: 'Polygon' },
      coordinates: { type: [[[Number]]], required: true },
    },
    area: { type: Number, required: true, min: 0 },
    color: { type: String, required: true, match: /^#[0-9A-Fa-f]{6}$/ },
    capturedAt: { type: Date, default: Date.now },
    name: { type: String, default: null, trim: true, maxlength: 60 },
    emoji: { type: String, default: null, trim: true, maxlength: 8 }, // Ultra: hudud emojisi
  },
  { timestamps: true },
);

// 2dsphere index for $geoIntersects / $geoWithin queries
territorySchema.index({ polygon: '2dsphere' });
territorySchema.index({ ownerId: 1 });
territorySchema.index({ teamId: 1 });

module.exports = model('Territory', territorySchema);
