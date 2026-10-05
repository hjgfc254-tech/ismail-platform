# منصة أ/ إسماعيل عماد التعليمية

منصة تعليمية لطلاب مستر إسماعيل عماد (من الصف الرابع الابتدائي إلى الثالث الثانوي): إعلانات، دروس (YouTube)، اختبارات بمحاولة واحدة وتصحيح في الخادم، منظّم دراسة أسبوعي مع مواقيت الصلاة، مساعد ذكي، وملف للطالب، بالإضافة إلى لوحة إدارة للمعلم.

## القيم الفعلية للمشروع

| العنصر | القيمة |
|---|---|
| مشروع Firebase | `manasty-e422d` |
| النطاق الرسمي (الواجهة + API) | `https://mrismailemad.com` |
| `WORKER_URL` في `env.js` | `https://mrismailemad.com` (لا يُعدَّل للإنتاج) |
| مسار الـ Worker | `mrismailemad.com/api/*` (معرَّف في `worker/wrangler.toml`) |
| اسم الـ Worker | `am-ismail-platform-api` |

> لا توجد قيم placeholder في الإعداد الحالي. إذا ظهر لك `PLACEHOLDER_WORKER_URL` في أي تعليمات قديمة فتجاهله؛ المرجع هو `env.js` وهذا الملف.

## المعمارية

```
المتصفح ──► mrismailemad.com
              ├─ /api/*  ──► Cloudflare Worker (Hono) ──► Firestore (REST + Service Account)
              └─ أي مسار آخر ──► Firebase Hosting (ملفات ثابتة)
```

- **الواجهة:** HTML/CSS/JS ثابتة على Firebase Hosting، ولا تكلّم Firestore مباشرة.
- **الـ Worker:** كل العمليات الحساسة (المصادقة، تصحيح الاختبارات، حصة AI، التحقق من المدخلات). يتصل بـ Firestore عبر REST باستخدام حساب الخدمة، ولا يستخدم `firebase-admin`.
- **Firestore Rules:** ترفض كل شيء افتراضيًا؛ الـ Worker لا يمرّ بها لكنها طبقة حماية إضافية.
- **مهم:** Firebase Hosting يحوّل أي مسار غير موجود إلى `index.html` (rewrite في `firebase.json`). لذلك إذا لم يصل `/api/*` إلى الـ Worker فسترى صفحة HTML بدل JSON (انظر «استكشاف الأخطاء»).

## بنية المشروع

```
index.html, login.html, subscribe.html, announcements.html,
lessons.html, exams.html, exam.html, planner.html, ai.html, profile.html
admin/            # صفحات لوحة الإدارة (login, index, codes, students, requests,
                  #   announcements, lessons, exams, results, settings, statistics)
css/              # tokens, base, components, layout, icons
js/               # helpers, router, auth, api, validation, ... + ملف لكل صفحة
icons/, images/
worker/           # index.js, package.json, wrangler.toml, .dev.vars.example
env.js            # إعداد الواجهة العام (Firebase config + WORKER_URL)
firebase.json     # Hosting + Firestore + Emulators
firestore.rules, firestore.indexes.json
```

ملفات غير موجودة في المستودع حاليًا ولا يلزم وجودها للنشر:

- `.firebaserc`: نحدّد المشروع صراحة بـ `--project manasty-e422d` في كل أمر Firebase.
- `worker/package-lock.json`: يُنشأ بتنفيذ `npm install` داخل `worker/` ثم يُرفع إلى المستودع (انظر الخطوة 2).

## المتطلبات

- Node.js 18 أو أحدث، وnpm
- Firebase CLI: `npm install -g firebase-tools` ثم `firebase login`
- Wrangler (يُثبَّت مع `npm install` داخل `worker/`، ويُشغَّل بـ `npx wrangler`)
- حساب Cloudflare يدير نطاق `mrismailemad.com` (Zone) ويُستخدم في `wrangler login`
- في Cloudflare DNS: سجل النطاق الذي يخدم الموقع يجب أن يكون **Proxied** (السحابة البرتقالية) حتى يعمل Route الخاص بالـ Worker

## الأسرار (Cloudflare Worker Secrets)

تُضاف من داخل `worker/` ولا تُكتب في أي ملف في المستودع ولا في `env.js`:

| الاسم | الوصف |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | محتوى JSON لحساب الخدمة (Firebase Console ← Project Settings ← Service Accounts ← Generate new private key) |
| `JWT_SECRET` | نص عشوائي طويل (32 حرفًا فأكثر)، مثال: `openssl rand -base64 32` |
| `AI_API_KEY` | مفتاح مزوّد الذكاء الاصطناعي. بدونه تعمل المنصة ويعيد مسار AI خطأً |
| `AI_PROVIDER` | `openai` أو `gemini` (الافتراضي `openai`) |

اختياريًا يمكن ضبط `AI_MODEL` و`AI_MAX_OUTPUT_TOKENS`. القيم العامة (`ALLOWED_ORIGINS`، مدد الجلسات، حد AI اليومي…) في قسم `[vars]` داخل `worker/wrangler.toml`.

احفظ ملف حساب الخدمة خارج المشروع. الملفات `*service-account*.json` و`.dev.vars` و`.env*` مستثناة في `.gitignore`.

## النشر

نفّذ الخطوات بهذا الترتيب.

### 0) قبل أي نشر

- تأكد أن `ismail.html` غير موجود (أداة توليد hash كلمة المرور، لا تُنشر).
- تأكد من خلو الملفات من الأسرار: لا مفاتيح AI ولا JSON لحساب الخدمة ولا `JWT_SECRET`. (`apiKey` في `env.js` مفتاح Firebase Web العام وليس سرًا.)
- راجع قائمة `hosting.ignore` في `firebase.json`؛ لأن `public = "."` يعني أن كل ملف في الجذر غير مستثنى سيُنشر.

### 1) تسجيل الدخول

```bash
firebase login
cd worker && npx wrangler login && cd ..
```

### 2) الـ Worker

```bash
cd worker
npm install                 # ينشئ package-lock.json أول مرة؛ ارفعه إلى المستودع
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
npx wrangler secret put JWT_SECRET
npx wrangler secret put AI_API_KEY
npx wrangler secret put AI_PROVIDER
npx wrangler deploy
cd ..
```

بعد `wrangler deploy` يصبح `https://mrismailemad.com/api/*` موجّهًا إلى الـ Worker. تحقق قبل الانتقال للواجهة:

```bash
curl -i https://mrismailemad.com/api/ping
```

المتوقع: `200` مع `Content-Type: application/json` وجسم يحتوي `"success": true` و`"pong": true`. إذا جاءك HTML فتوقف وراجع «استكشاف الأخطاء».

### 3) الواجهة والقواعد والفهارس

لا تعدّل `env.js` للإنتاج (قيمته الحالية صحيحة). من جذر المشروع:

```bash
firebase deploy --only hosting,firestore:rules,firestore:indexes --project manasty-e422d
```

للتحديثات اللاحقة، انشر الجزء المتغيّر فقط:

```bash
firebase deploy --only hosting --project manasty-e422d
firebase deploy --only firestore:rules --project manasty-e422d
firebase deploy --only firestore:indexes --project manasty-e422d
cd worker && npx wrangler deploy
```

### 4) الفحص بعد النشر

1. `curl -i https://mrismailemad.com/api/ping` يعيد JSON (وليس `index.html`).
2. افتح `https://mrismailemad.com` وسجّل الدخول بحساب طالب تجريبي، ثم تأكد من بقاء الجلسة بعد تحديث الصفحة.
3. افتح `https://mrismailemad.com/admin/login` وسجّل دخول الإدارة.
4. تحقق من CORS للأصل الرسمي:
   ```bash
   curl -i -X OPTIONS https://mrismailemad.com/api/ping \
     -H "Origin: https://mrismailemad.com" \
     -H "Access-Control-Request-Method: GET"
   ```
5. تأكد أن استجابات `/api/*` تحمل `Cache-Control: no-store`.
6. راقب الأخطاء: Console في المتصفح، وسجلات الـ Worker بالأمر `cd worker && npx wrangler tail`.
7. تأكد أن الرد على اختبار الطالب لا يتضمن `correctIndex` قبل التسليم.

## التطوير المحلي

الـ Worker يتصل دائمًا بـ Firestore الحقيقي (لا يستخدم Firestore emulator)، فاستخدم مشروعًا تجريبيًا أو بيانات اختبار فقط.

1. **الـ Worker:**
   ```bash
   cd worker
   cp .dev.vars.example .dev.vars   # ثم أضف الأسرار المحلية في .dev.vars (غير مرفوع)
   npm install
   npm run dev                      # http://localhost:8787
   ```
   `.dev.vars.example` يضبط `ALLOWED_ORIGINS` لـ `localhost:5000` و`localhost:3000`.
2. **الواجهة:** `firebase emulators:start --only hosting --project manasty-e422d` على `http://localhost:5000`.
3. **ربط الواجهة بالـ Worker المحلي (مؤقتًا):** في `env.js` ضع `WORKER_URL = "http://localhost:8787"`، وأضف `http://localhost:8787` إلى `connect-src` في ترويسة `Content-Security-Policy` داخل `firebase.json` (وإلا سيحجب المتصفح الطلبات). **أعد القيمتين كما كانتا قبل أي commit أو نشر.**

## مجموعات Firestore

`admins`، `codes`، `students`، `subscriptionRequests`، `announcements`، `announcementReplies`، `announcementReads`، `lessons`، `lessonGroups`، `lessonProgress`، `exams` (تحتوي `correctIndex`)، `examAttempts`، `planner`، `studySessions`، `aiUsage`، `loginRateLimits`، `settings`.

تُنشأ المجموعات تلقائيًا عند أول كتابة. الفهارس المطلوبة معرّفة في `firestore.indexes.json`.

## الأمان

- لا أسرار في الواجهة ولا في المستودع.
- كل العمليات الحساسة في الـ Worker، وقواعد Firestore ترفض الوصول المباشر.
- تصحيح الاختبارات في الخادم، ولا يُرسل `correctIndex` للطالب.
- حصة AI اليومية وحجم الطلب يُفرضان في الخادم.
- روابط الإعلانات يتحقق منها الخادم في `POST/PATCH /api/admin/announcements`: الرابط الداخلي مسار نسبي فقط (يُرفض `javascript:` و`data:` و`http(s)://` و`//`)، والخارجي عنوان مطلق `http` أو `https`.
- CORS لا يغني عن التحقق من التوكن والصلاحيات داخل الـ Worker.

## استكشاف الأخطاء

**`/api/*` يعيد HTML أو 404 بدل JSON:** الطلب يصل إلى Firebase Hosting وليس الـ Worker. تحقق من: نشر الـ Worker (`npx wrangler deploy`)، وأن Route `mrismailemad.com/api/*` ظاهر في Cloudflare ← Workers ← Settings ← Routes، وأن النطاق في نفس حساب Cloudflare، وأن سجل DNS في وضع Proxied.

**الواجهة لا تصل للـ Worker / `NETWORK_ERROR`:** تأكد أن `WORKER_URL` في `env.js` هو `https://mrismailemad.com`، وأن `curl /api/ping` يعمل، وأن الأصل مذكور في `ALLOWED_ORIGINS` (`wrangler.toml`)، وأن النطاق مسموح في `connect-src` داخل `firebase.json`. راجع `npx wrangler tail`.

**`FIREBASE_SERVICE_ACCOUNT secret is missing` (أو `JWT_SECRET`):** أضف السر من داخل `worker/` بـ `npx wrangler secret put <NAME>` ثم أعد `npx wrangler deploy`.

**Firestore يطلب فهرسًا (`The query requires an index`):** افتح الرابط الظاهر في رسالة الخطأ، أو أضف الفهرس في `firestore.indexes.json` وانشر `firestore:indexes`.

**أمر Firebase يطلب مشروعًا:** لا يوجد `.firebaserc`؛ أضف `--project manasty-e422d` للأمر.
