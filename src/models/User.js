const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 50 },
    email: { type: String, required: false, unique: true, sparse: true, trim: true, lowercase: true },
    phone: { type: String, unique: true, sparse: true, trim: true },
    passwordHash: { type: String, required: true },
    teamId: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
    color: { type: String, default: '#00ff88', match: /^#[0-9A-Fa-f]{6}$/ },
    avatarUrl: { type: String, default: null },
    xp: { type: Number, default: 0, min: 0 },
    level: { type: Number, default: 1, min: 1 },
    totalArea: { type: Number, default: 0, min: 0 },
    totalDistance: { type: Number, default: 0, min: 0 },
    territoriesCaptured: { type: Number, default: 0, min: 0 },
    territoriesLost: { type: Number, default: 0, min: 0 },
    // GeoJSON Point: { type: 'Point', coordinates: [lng, lat] }
    lastLocation: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
    lastSeen: { type: Date, default: null },
    // Leaderboard scope uchun — GPS'dan reverse-geocode bilan to'ldiriladi (client yuboradi)
    city: { type: String, default: null, trim: true, maxlength: 80 },
    country: { type: String, default: null, trim: true, maxlength: 80 },
    isOnline: { type: Boolean, default: false },
    socketId: { type: String, default: null },
    expoPushToken: { type: String, default: null },
    termsAccepted: { type: Boolean, default: false },
    isAdmin:  { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    passwordResetToken:   { type: String, default: null, select: false },
    passwordResetExpires: { type: Date,   default: null, select: false },

    // ── Shop / Cosmetics ──────────────────────────────────────────────────────
    coins:          { type: Number, default: 0, min: 0 },
    ownedSkins:     { type: [String], default: [] },
    activeSkinColor:  { type: String, default: null },
    activeSkinMarker: { type: String, default: null },
    activeSkinTrail:  { type: String, default: null },
    lastDailyClaim: { type: Date, default: null },

    // ── Premium obuna ─────────────────────────────────────────────────────────
    isPremium:      { type: Boolean, default: false },
    premiumUntil:   { type: Date, default: null },
    // Pog'ona: 'free' | 'pro' | 'ultra'. Eski premiumlarda yo'q → tierOf() 'pro' deb oladi.
    premiumTier:    { type: String, enum: ['free', 'pro', 'ultra'], default: 'free' },
    telegramChatId: { type: String, default: null },
  },
  { timestamps: true },
);

// 2dsphere index for geospatial queries on last location
userSchema.index({ lastLocation: '2dsphere' }, { sparse: true });
userSchema.index({ xp: -1 });
userSchema.index({ teamId: 1 });

module.exports = model('User', userSchema);
