/**
 * api.js
 * ------------------------------------------------------------
 * منصة أ/ إسماعيل عماد التعليمية
 * الطبقة الموحدة للتواصل مع Cloudflare Worker.
 *
 * المكان: /js/api.js
 *
 * المرجع:
 *   - الوثيقة الأصلية (بنود 47، 64، 90، 99، 111، 112، 113، 114،
 *                       129، 130، 141، 205)
 *
 * ⚠️ قواعد صارمة:
 *   - لا يتم الاتصال بـ Firestore من الفرونت مباشرة (بند 6، 109).
 *   - كل العمليات الحساسة تمر من Worker.
 *   - الرد الموحد: { success, data } أو { success:false, error } (بند 112).
 *   - الفرونت يعتمد على error.code وليس نص الرسالة (بند 114).
 *
 * ⚠️ حالة الملف:
 *   - WORKER_URL = PLACEHOLDER_WORKER_URL (البند 207).
 *   - سترجع NETWORK_ERROR حتى بناء الـ Worker (المرحلة 4).
 *   - هذا سلوك متوقع ومقصود.
 *
 * Endpoints المستهدفة (مبدئية — تُثبَّت أثناء بناء Worker):
 *   GET  /api/lessons
 *   GET  /api/announcements
 *   POST /api/announcements/reply
 *   GET  /api/exams
 *   POST /api/exams/start
 *   POST /api/exams/submit
 *   GET  /api/exams/result
 *   GET  /api/planner/tasks
 *   POST /api/planner/tasks
 *   PATCH /api/planner/tasks/:id
 *   DELETE /api/planner/tasks/:id
 *   POST /api/planner/sessions
 *   POST /api/ai/chat
 *   GET  /api/student/profile
 *   GET  /api/ping
 * ------------------------------------------------------------
 */

import { WORKER_URL } from "../env.js";
import { getSession, setSession, clearSession } from "./router.js";
import { safeText } from "./helpers.js";


/* ============================================================
   01 — ثوابت
   المرجع: الوثيقة الأصلية — بنود 113، 114، 141
   ============================================================ */

/**
 * أكواد الأخطاء الموحدة.
 * (نفس المبدأ المتبع في auth.js — بند 114)
 */
export const API_ERRORS = {
  UNAUTHORIZED:      "UNAUTHORIZED",
  FORBIDDEN:         "FORBIDDEN",
  NOT_FOUND:         "NOT_FOUND",
  BAD_REQUEST:       "BAD_REQUEST",
  ALREADY_ATTEMPTED: "ALREADY_ATTEMPTED",
  DAILY_LIMIT_REACHED: "DAILY_LIMIT_REACHED",
  RATE_LIMITED:        "RATE_LIMITED",
  TIMEOUT:           "TIMEOUT",
  NETWORK_ERROR:     "NETWORK_ERROR",
  SERVER_ERROR:      "SERVER_ERROR"
};

/**
 * رسائل الأخطاء المعروضة للطالب.
 * المرجع: Master Design System — بند 36 + الوثيقة الأصلية — بند 142
 * القاعدة: لا تُعرض تفاصيل تقنية.
 */
const API_ERROR_MESSAGES = {
  UNAUTHORIZED:        "انتهت الجلسة. يرجى تسجيل الدخول مرة أخرى.",
  FORBIDDEN:           "غير مسموح بهذا الإجراء.",
  NOT_FOUND:           "العنصر المطلوب غير موجود.",
  BAD_REQUEST:         "حدث خطأ في الطلب. حاول مرة أخرى.",
  ALREADY_ATTEMPTED:   "تم أداء هذا الاختبار بالفعل.",
  DAILY_LIMIT_REACHED: "تجاوزت الحد اليومي المسموح. حاول غدًا.",
  RATE_LIMITED:        "محاولات كثيرة. حاول بعد قليل.",
  TIMEOUT:             "انتهت مدة الطلب. حاول مرة أخرى.",
  NETWORK_ERROR:       "لا يوجد اتصال بالإنترنت. حاول مرة أخرى.",
  SERVER_ERROR:        "حدث خطأ. حاول مرة أخرى."
};

/**
 * ترجمة كود الخطأ إلى رسالة عربية.
 * @param {string} code
 * @returns {string}
 */
export function getApiErrorMessage(code) {
  return API_ERROR_MESSAGES[code] || API_ERROR_MESSAGES.SERVER_ERROR;
}


/* ============================================================
   02 — طلب HTTP موحّد
   المرجع: الوثيقة الأصلية — بنود 112، 113، 114
   ============================================================ */

const REQUEST_TIMEOUT_MS = 20000; // 20 ثانية (AI قد يحتاج وقتًا أطول)

// مشاركة عملية التجديد بين الطلبات المتزامنة لمنع تنفيذ عدة refresh
// لنفس الجلسة في الوقت نفسه.
let refreshPromise = null;

/**
 * إرسال طلب إلى الـ Worker.
 *
 * السلوك:
 *   - يضيف Authorization تلقائيًا إن وُجد Token.
 *   - يفرض Timeout (بند 141).
 *   - عند استقبال 401: يمسح الجلسة ويعيد UNAUTHORIZED.
 *
 * @param {string} endpoint - مثل "/api/lessons"
 * @param {Object} options
 * @param {string} options.method - GET / POST / PATCH / DELETE
 * @param {Object} options.body
 * @param {Object} options.query - باراميترات الرابط
 * @param {number} options.timeout - تجاوز المهلة الافتراضية
 * @returns {Promise<Object>}
 */
async function workerRequest(endpoint, options = {}) {
  const {
    method = "GET",
    body = null,
    query = null,
    timeout = REQUEST_TIMEOUT_MS,
    retry401 = true
  } = options;

  // حماية: WORKER_URL غير مضبوط
  if (!WORKER_URL || WORKER_URL === "PLACEHOLDER_WORKER_URL") {
    return {
      success: false,
      error: {
        code: API_ERRORS.NETWORK_ERROR,
        message: API_ERROR_MESSAGES.NETWORK_ERROR
      }
    };
  }

  // بناء الرابط
  let url = `${WORKER_URL}${endpoint}`;
  if (query && typeof query === "object") {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        params.append(k, v);
      }
    });
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  // الهيدرز
  const headers = {
    "Content-Type": "application/json"
  };

  const session = getSession();
  if (session && session.token) {
    headers["Authorization"] = `Bearer ${session.token}`;
  }

  // Timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // 401 → حاول تجديد الجلسة مرة واحدة ثم أعد الطلب الأصلي مرة واحدة.
    // طلب التجديد لا يمر عبر workerRequest حتى لا يدخل في حلقة 401 → refresh → 401.
    if (response.status === 401) {
      const currentSession = getSession();

      if (retry401 && currentSession?.refreshToken) {
        try {
          if (!refreshPromise) {
            const refreshTokenValue = currentSession.refreshToken;
            refreshPromise = (async () => {
              const refreshController = new AbortController();
              const refreshTimeoutId = setTimeout(() => refreshController.abort(), timeout);
              try {
                const refreshResponse = await fetch(`${WORKER_URL}/api/auth/refresh`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${refreshTokenValue}`
                  },
                  body: JSON.stringify({ refreshToken: refreshTokenValue }),
                  signal: refreshController.signal
                });

                let refreshPayload = null;
                try {
                  refreshPayload = await refreshResponse.json();
                } catch (e) {
                  refreshPayload = null;
                }

                if (!refreshResponse.ok || !refreshPayload?.success || !refreshPayload.data?.token) {
                  return false;
                }

                const latestSession = getSession() || currentSession;
                setSession({
                  ...latestSession,
                  token: refreshPayload.data.token,
                  refreshToken: refreshPayload.data.refreshToken || latestSession.refreshToken || refreshTokenValue
                });
                return true;
              } finally {
                clearTimeout(refreshTimeoutId);
              }
            })().finally(() => {
              refreshPromise = null;
            });
          }

          if (await refreshPromise) {
            // إعادة الطلب الأصلي مرة واحدة فقط.
            return workerRequest(endpoint, {
              ...options,
              retry401: false
            });
          }
        } catch (e) {
          // سيفشل التجديد أدناه ويؤدي إلى تسجيل الدخول مجددًا.
        }
      }

      clearSession();
      return {
        success: false,
        error: {
          code: API_ERRORS.UNAUTHORIZED,
          message: API_ERROR_MESSAGES.UNAUTHORIZED
        }
      };
    }

    // قراءة الرد
    let payload;
    try {
      payload = await response.json();
    } catch (e) {
      return {
        success: false,
        error: {
          code: API_ERRORS.SERVER_ERROR,
          message: API_ERROR_MESSAGES.SERVER_ERROR
        }
      };
    }

    // الرد المتوقع (بند 112)
    if (payload && typeof payload.success === "boolean") {
      return payload;
    }

    return {
      success: false,
      error: {
        code: API_ERRORS.SERVER_ERROR,
        message: API_ERROR_MESSAGES.SERVER_ERROR
      }
    };

  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === "AbortError") {
      return {
        success: false,
        error: {
          code: API_ERRORS.TIMEOUT,
          message: API_ERROR_MESSAGES.TIMEOUT
        }
      };
    }

    return {
      success: false,
      error: {
        code: API_ERRORS.NETWORK_ERROR,
        message: API_ERROR_MESSAGES.NETWORK_ERROR
      }
    };
  }
}


/* ============================================================
   03 — الدروس
   المرجع: الوثيقة الأصلية — بنود 31، 32، 33، 34
   ============================================================ */

/**
 * جلب دروس الطالب.
 * @param {Object} options
 * @param {"video"|"audio"|null} options.kind - نوع الدرس
 * @returns {Promise<Object>}
 */
export async function getLessons({ kind = null } = {}) {
  const query = {};
  if (kind === "video" || kind === "audio") {
    query.kind = kind;
  }
  return workerRequest("/api/lessons", { query });
}

/** تسجيل فتح الدرس لدى Worker. */
export async function markLessonOpened(lessonId) {
  const cleanId = safeText(lessonId);
  if (!cleanId) return { success: false, error: { code: API_ERRORS.BAD_REQUEST, message: "معرّف الدرس مطلوب." } };
  return workerRequest(`/api/lessons/${encodeURIComponent(cleanId)}/open`, { method: "POST" });
}


/* ============================================================
   04 — الإعلانات والردود
   المرجع: الوثيقة الأصلية — بنود 25، 26، 27، 28، 29، 30، 78، 79
   ============================================================ */

/**
 * جلب إعلانات الطالب.
 * @returns {Promise<Object>}
 */
export async function getAnnouncements() {
  return workerRequest("/api/announcements");
}

/**
 * عدد الإعلانات غير المقروءة.
 * @returns {Promise<Object>}
 */
export async function getUnreadCount() {
  return workerRequest("/api/announcements/unread-count");
}

/** تسجيل قراءة إعلان. */
export async function markAnnouncementRead(announcementId) {
  const cleanId = safeText(announcementId);
  if (!cleanId) return { success: false, error: { code: API_ERRORS.BAD_REQUEST, message: "معرّف الإعلان مطلوب." } };
  return workerRequest(`/api/announcements/${encodeURIComponent(cleanId)}/read`, { method: "POST" });
}

/**
 * الرد على إعلان.
 * الرد لا يظهر إلا للمعلم/الإدارة (بند 30).
 *
 * @param {string} announcementId
 * @param {string} message
 * @returns {Promise<Object>}
 */
export async function replyToAnnouncement(announcementId, message) {
  const cleanId  = safeText(announcementId);
  const cleanMsg = safeText(message);

  if (!cleanId || !cleanMsg) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "لا يمكن إرسال رد فارغ."
      }
    };
  }

  return workerRequest("/api/announcements/reply", {
    method: "POST",
    body: {
      announcementId: cleanId,
      message: cleanMsg
    }
  });
}


/* ============================================================
   05 — الاختبارات
   المرجع: الوثيقة الأصلية — بنود 35، 36، 42، 43، 44، 45، 82، 83، 84، 128
   ============================================================ */

/**
 * جلب الاختبارات المتاحة/المؤدّاة.
 * @returns {Promise<Object>}
 */
export async function getExams() {
  return workerRequest("/api/exams");
}

/**
 * بدء محاولة اختبار.
 * الـ Worker يتحقق من:
 *   - هوية الطالب.
 *   - المرحلة.
 *   - عدم وجود محاولة سابقة (بند 41، 128).
 *
 * @param {string} examId
 * @returns {Promise<Object>}
 */
export async function startExam(examId) {
  const cleanId = safeText(examId);
  if (!cleanId) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "معرّف الاختبار مطلوب."
      }
    };
  }
  return workerRequest("/api/exams/start", {
    method: "POST",
    body: { examId: cleanId }
  });
}

/**
 * إرسال الاختبار.
 * ⚠️ الـ Worker هو المسؤول عن التصحيح (بند 42).
 * ⚠️ منع الإرسال المزدوج (بند 184، 187).
 *
 * @param {string} examId
 * @param {Array<number>} answers - اختيارات الطالب لكل سؤال
 * @returns {Promise<Object>}
 */
export async function submitExam(examId, answers) {
  const cleanId = safeText(examId);
  if (!cleanId || !Array.isArray(answers)) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "بيانات الاختبار غير مكتملة."
      }
    };
  }
  return workerRequest("/api/exams/submit", {
    method: "POST",
    body: {
      examId: cleanId,
      answers
    }
  });
}

/**
 * جلب نتيجة اختبار.
 * المرجع: الوثيقة الأصلية — بند 45
 *
 * @param {string} examId
 * @returns {Promise<Object>}
 */
export async function getExamResult(examId) {
  const cleanId = safeText(examId);
  if (!cleanId) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "معرّف الاختبار مطلوب."
      }
    };
  }
  return workerRequest("/api/exams/result", {
    query: { examId: cleanId }
  });
}


/* ============================================================
   06 — المنظم (Planner)
   المرجع: الوثيقة الأصلية — بنود 46، 50، 51، 52، 53، 54، 55
   ============================================================ */

/**
 * جلب مهام الطالب.
 * @param {Object} options
 * @param {string} options.week - بداية الأسبوع (ISO date)
 * @param {string} options.day  - يوم محدد (ISO date)
 * @returns {Promise<Object>}
 */
export async function getPlannerTasks({ week = null, day = null } = {}) {
  const query = {};
  if (week) query.week = week;
  if (day)  query.day  = day;
  return workerRequest("/api/planner/tasks", { query });
}

/**
 * إنشاء مهمة جديدة.
 * @param {Object} payload
 * @param {string} payload.title
 * @param {string} payload.day
 * @param {string} payload.time
 * @param {string} payload.week - مفتاح الأسبوع (YYYY-MM-DD)، إلزامي حتى لا يعتمد الـ Worker على fallback ضمني.
 * @param {string} [payload.subject]
 * @returns {Promise<Object>}
 */
export async function createTask(payload) {
  const title = safeText(payload?.title);
  const day   = safeText(payload?.day);
  const time  = safeText(payload?.time);
  const week  = safeText(payload?.week);

  if (!title || !day || !time || !week) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "بيانات المهمة غير مكتملة."
      }
    };
  }

  return workerRequest("/api/planner/tasks", {
    method: "POST",
    body: {
      title,
      day,
      time,
      week,
      subject: safeText(payload?.subject) || null
    }
  });
}

/**
 * تعديل مهمة.
 * @param {string} taskId
 * @param {Object} payload - يجب أن يحتوي على week الخاص بالمهمة حتى يلاقيها الـ Worker في الوثيقة الصحيحة.
 * @returns {Promise<Object>}
 */
export async function updateTask(taskId, payload) {
  const cleanId = safeText(taskId);
  if (!cleanId) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "معرّف المهمة مطلوب."
      }
    };
  }
  return workerRequest(`/api/planner/tasks/${encodeURIComponent(cleanId)}`, {
    method: "PATCH",
    body: payload || {}
  });
}

/**
 * حذف مهمة.
 * @param {string} taskId
 * @param {string} week - مفتاح الأسبوع الخاص بالمهمة (YYYY-MM-DD)، إلزامي حتى لا يعتمد الـ Worker على fallback ضمني.
 * @returns {Promise<Object>}
 */
export async function deleteTask(taskId, week) {
  const cleanId = safeText(taskId);
  if (!cleanId) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "معرّف المهمة مطلوب."
      }
    };
  }
  return workerRequest(`/api/planner/tasks/${encodeURIComponent(cleanId)}`, {
    method: "DELETE",
    query: { week: safeText(week) }
  });
}

/**
 * إكمال/إلغاء إكمال مهمة.
 * @param {string} taskId
 * @param {boolean} done
 * @param {string} week - مفتاح الأسبوع الخاص بالمهمة.
 * @returns {Promise<Object>}
 */
export async function toggleTask(taskId, done, week) {
  return updateTask(taskId, { done: !!done, week: safeText(week) });
}

/**
 * تسجيل جلسة مذاكرة.
 * المرجع: الوثيقة الأصلية — بند 55
 *
 * @param {number} durationMinutes
 * @returns {Promise<Object>}
 */
export async function logStudySession(durationMinutes) {
  const mins = Number(durationMinutes);
  if (!mins || mins <= 0) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "مدة الجلسة غير صحيحة."
      }
    };
  }
  return workerRequest("/api/planner/sessions", {
    method: "POST",
    body: { durationMinutes: mins }
  });
}


/* ============================================================
   07 — المساعد الذكي (AI)
   المرجع: الوثيقة الأصلية — بنود 56، 61، 62، 63، 65، 129، 141
   ⚠️ الـ API Key موجود في الـ Worker فقط (بند 62).
   ============================================================ */

/**
 * إرسال رسالة إلى المساعد الذكي.
 * @param {Array<Object>} messages - [{ role: "user"|"assistant", content }]
 * @returns {Promise<Object>}
 */
export async function sendAIMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      success: false,
      error: {
        code: API_ERRORS.BAD_REQUEST,
        message: "لا يمكن إرسال رسالة فارغة."
      }
    };
  }

  // ⚠️ لا نضع حدًا للسياق هنا — الـ Worker يقرر (بند 65).
  // الفرونت يرسل ما لديه فقط.

  return workerRequest("/api/ai/chat", {
    method: "POST",
    body: { messages },
    // AI قد يحتاج وقتًا أطول (بند 141)
    timeout: 60000
  });
}


/* ============================================================
   08 — الملف الشخصي
   المرجع: الوثيقة الأصلية — بنود 67، 68، 69، 70، 71، 138
   ============================================================ */

/**
 * جلب ملف الطالب وإحصائياته.
 * @returns {Promise<Object>}
 */
export async function getStudentProfile() {
  return workerRequest("/api/student/profile");
}


/* ============================================================
   09 — أدوات عامة
   ============================================================ */

/**
 * اختبار الاتصال بالـ Worker.
 * @returns {Promise<Object>}
 */
export async function ping() {
  return workerRequest("/api/ping");
}