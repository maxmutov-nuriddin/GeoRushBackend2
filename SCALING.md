# GeoRush Backend — Scale-out qo'llanmasi (100k+ bir vaqtda onlayn)

Backend IKKI rejimda ishlaydi. Rejim **faqat env bilan** tanlanadi, kod bitta:

| Rejim | Qachon | Env |
|---|---|---|
| **Bitta instance** (default) | Hozirgi production. Hech narsa o'zgartirmang. | `REDIS_URL` berilmaydi — barcha holat xotirada, avvalgi xulq bilan aynan bir xil |
| **Scale-out** | ~2 000+ bir vaqtda onlayn kerak bo'lganda | Har instance'ga `REDIS_URL`; bittasidan boshqa hammasiga `BOT_POLLING=false` |

## Scale-out rejimida nima o'zgaradi

`REDIS_URL` berilganda avtomatik:

1. **Socket.IO Redis adapter** — `io.to(room).emit` barcha instance'larga yetadi
   (jamoa broadcast, global territory:new, user:{id} manzillash, admin room).
2. **Trail'lar Redis listlarida** (`trailStore`) — REST capture qaysi instance'ga
   tushishidan qat'i nazar trail topiladi; trim semantikasi (boshlanish nuqtasi
   saqlanadi) atomik Lua skriptda.
3. **Onlayn reestr mirror** (`onlineStore`) — players:init jamoadoshlari, capture
   effektlari, admin live-map va stale-disconnect guard barcha instance'larni ko'radi.
   Hot path baribir lokal Map'da — Redis'ga yozish 15s tick + 60s heartbeat.
4. **Telegram bot** — polling faqat `BOT_POLLING=false` qo'yilMAGAN instance'da.
   Qolganlar ham invoice/xabar YUBORA oladi (yuborish polling talab qilmaydi).

Anti-cheat pozitsiyalari, masofa akkumulyatori, cheat-aggregatsiya — atayin lokal
(userning socketi turgan instance'da): bu ma'lumotlar faqat o'sha socket oqimida kerak.

## 100k bir vaqtda onlayn uchun topologiya

```
                       ┌─ LB (sticky session YOKI faqat websocket) ─┐
 Mobil/Web ──────────► │  App instance × 10–16 (2 vCPU / 2–4 GB)   │
                       └──────────────┬────────────────────────────┘
                                      │
                 ┌────────────────────┼───────────────────────┐
                 ▼                    ▼                       ▼
          Redis 4–8 GB          PgBouncer                Expo Push API
       (yoki 3-shard cluster)       │
                                    ▼
                          PostgreSQL + PostGIS
                        (4–8 vCPU, read replica ixtiyoriy)
```

### Yuk hisobi (100k onlayn, har user 2s da bitta lokatsiya)

| Resurs | Hajm | Izoh |
|---|---|---|
| Socket xabar (kirish) | ~50 000 msg/s jami | instance boshiga ~3–5k msg/s — Node uchun normal |
| Redis: trail RPUSH | ~50 000 op/s | bitta katta Redis chegarasida; 3 shard bilan bemalol |
| Redis: mirror/heartbeat | ~7 000 op/s | 15s/60s tick'lar |
| DB: lokatsiya persist | ~6 700 qps update | 15s da bir user; `LOCATION_PERSIST_INTERVAL_MS=30000` qilsa 2 barobar kamayadi |
| DB: proximity PostGIS | ~3 300 qps | 30s throttle; GiST indeks SHART (pastga qarang) |
| RAM (trail, Redis) | o'rtacha ~1–2 GB, max ~6 GB | 24h TTL yetim kalitlarni tozalaydi |

### Bosqichma-bosqich o'sish

| Onlayn | Kerak |
|---|---|
| ≤ 2k | Hozirgi bitta instance (vertical: 2 vCPU/2GB) — Redis SHART EMAS |
| 2–10k | `REDIS_URL` + 2–3 instance + PgBouncer |
| 10–50k | 4–8 instance, Redis 2–4 GB, Postgres 4 vCPU, `LOCATION_PERSIST_INTERVAL_MS=30000` |
| 50–100k+ | 10–16 instance, Redis cluster/shard, Postgres 8 vCPU + replica, push'larni queue'ga olish (keyingi bosqich) |

## Majburiy tekshiruvlar (scale'dan OLDIN)

**1. PostGIS va GiST indeks ishlayaptimi** (ishlamasa har capture full-scan bo'ladi):

```sql
SELECT extname FROM pg_extension WHERE extname = 'postgis';
SELECT indexname FROM pg_indexes WHERE tablename = 'Territory';
-- idx_territory_geom ko'rinishi kerak. Yo'q bo'lsa server loglarida
-- "Index skip:" qatorini toping — sababi o'sha yerda.
```

**2. Prisma ulanish limiti** — har instance'ga pool chegarasi (PgBouncer'siz jami
ulanish = instance × limit Postgres `max_connections`dan oshmasin):

```
DATABASE_URL="postgresql://...?connection_limit=10&pool_timeout=20"
```

**3. Sticky session** — Socket.IO `polling` transporti bir nechta instance'da LB
session-affinity talab qiladi. Affinity bo'lmasa, client'larda faqat websocket
qoldirish ham yechim (clientda `transports: ['websocket']`).

## Bilib qo'yish kerak bo'lgan chegaralar (scale rejimida)

- **Rate-limit va IP-blok per-instance** — N instance'da limitlar N barobar yumshaydi.
  Qattiq kerak bo'lsa keyingi bosqichda `rate-limit-redis` store qo'shiladi.
- **Leaderboard kesh per-instance** (TTL 5 min) — instance'lar orasida ±5 daqiqa farq
  bo'lishi mumkin; bu kesh dizayni, xato emas.
- **players:init pozitsiyasi** mirror'dan (≤15s eski) olinadi — keyingi harakatlar
  jonli `player:moved` orqali real-time keladi.
- Instance qulasa, uning userlari reconnect bo'ladi; o'lik mirror yozuvlarini
  sweep (10 min) tozalaydi.

## Env jadval (scale-out qo'shimchalari — hammasi IXTIYORIY)

| Env | Default | Tavsif |
|---|---|---|
| `REDIS_URL` | (yo'q = o'chiq) | `redis://:parol@host:6379` — berilsa scale-out yoqiladi |
| `BOT_POLLING` | `true` | `false` = bu instance Telegram xabarlarini QABUL qilmaydi (yuboradi) |
| `LOCATION_PERSIST_INTERVAL_MS` | `15000` | DB yozish oralig'i; 30000 = DB yuki 2x kam |
| `MAX_TRAIL_POINTS` | `2000` | Trail uzunligi (RAM/Redis hajmiga ta'sir qiladi) |

Deploy checklist (scale-out):
1. Redis yarating, `REDIS_URL`ni BARCHA instance'larga qo'ying.
2. Bitta instance'da `BOT_POLLING` qoldiring (default true), qolganlarga `false`.
3. PgBouncer yoki `connection_limit` sozlang.
4. Yuqoridagi 2 ta SQL tekshiruvini bajaring.
5. Instance sonini 2 dan boshlab oshiring, Sentry/loglarni kuzating.
