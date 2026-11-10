'use strict';

// Lightweight multilingual NLP/NLU layer: script detection, Latin-script
// language scoring, polyglot command recognition, and localized replies.
// It normalizes diacritics so accented and plain spellings both match.

function normalize(text) {
  return String(text || '').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s'-]/gu, ' ')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

const SCRIPT_LANGUAGES = [
  { lang: 'ja', re: /[\u3040-\u30ff]/ },
  { lang: 'ko', re: /[\uac00-\ud7af\u1100-\u11ff]/ },
  { lang: 'zh', re: /[\u4e00-\u9fff]/ },
  { lang: 'hi', re: /[\u0900-\u097f]/ },
  { lang: 'bn', re: /[\u0980-\u09ff]/ },
  { lang: 'pa', re: /[\u0a00-\u0a7f]/ },
  { lang: 'mr', re: /[\u0900-\u097f]/ },
  { lang: 'ta', re: /[\u0b80-\u0bff]/ },
  { lang: 'te', re: /[\u0c00-\u0c7f]/ },
  { lang: 'ar', re: /[\u0600-\u06ff]/ },
  { lang: 'ru', re: /[\u0400-\u04ff]/ }
];

const URDU_MARKERS = /[\u06a9\u06af\u06ba\u06be\u06c1\u06d2]/;
const UKRAINIAN_MARKERS = /[\u0456\u0457\u0454]/;

const LATIN_HINTS = {
  'hi-Latn': ['hai', 'kya', 'mujhe', 'karo', 'aao', 'aaja', 'jao', 'bhai', 'chahiye', 'mera', 'tum', 'aap', 'nahi', 'haan', 'theek', 'piche', 'peeche', 'ruko', 'bas', 'kaise', 'kyun', 'kahan', 'batao', 'yaar', 'namaste', 'dhanyavad', 'shukriya', 'khao', 'soja', 'jaldi'],
  es: ['hola', 'gracias', 'que', 'como', 'donde', 'por favor', 'quiero', 'necesito', 'ven', 'sigueme', 'buenos', 'amigo', 'ayuda', 'adios'],
  fr: ['bonjour', 'merci', 'comment', 'ou', 'je', 'tu', 'veux', 'besoin', 'viens', 'suis', 'salut', 'aide', 'oui', 'non'],
  de: ['hallo', 'danke', 'wie', 'wo', 'ich', 'du', 'will', 'brauche', 'komm', 'folge', 'bitte', 'hilfe', 'nein', 'ja'],
  pt: ['ola', 'obrigado', 'como', 'onde', 'eu', 'voce', 'quero', 'preciso', 'vem', 'siga', 'ajuda', 'sim', 'nao'],
  it: ['ciao', 'grazie', 'come', 'dove', 'io', 'tu', 'voglio', 'bisogno', 'vieni', 'seguimi', 'aiuto', 'si', 'no'],
  nl: ['hallo', 'dank', 'hoe', 'waar', 'ik', 'jij', 'wil', 'nodig', 'kom', 'volg', 'alsjeblieft', 'help'],
  pl: ['czesc', 'dzieki', 'jak', 'gdzie', 'ja', 'ty', 'chce', 'potrzebuje', 'chodz', 'prosze', 'pomoc'],
  tr: ['merhaba', 'tesekkur', 'nasil', 'nerede', 'ben', 'sen', 'istiyorum', 'gel', 'takip', 'lutfen', 'yardim'],
  id: ['halo', 'terima kasih', 'bagaimana', 'mana', 'saya', 'kamu', 'mau', 'butuh', 'datang', 'ikuti', 'tolong', 'bantu'],
  vi: ['xin chao', 'cam on', 'the nao', 'o dau', 'toi', 'ban', 'muon', 'can', 'den', 'giup']
};

const STRONG_HINTS = new Set(['namaste', 'namaskar', 'dhanyavad', 'shukriya', 'salaam', 'salam', 'assalamu', 'bonjour', 'merci', 'danke', 'gracias', 'obrigado', 'ciao', 'grazie', 'privet', 'merhaba', 'terima kasih', 'xin chao', 'czesc', 'prosze', 'hola', 'aaja', 'aao', 'ruko', 'theek', 'bhai', 'yaar', 'kya', 'komm', 'gel', 'vem', 'vieni']);

const HINGLISH_HINTS = new Set(['namaste', 'namaskar', 'dhanyavad', 'shukriya', 'salaam', 'salam', 'assalamu', 'aaja', 'aao', 'ruko', 'theek', 'bhai', 'yaar', 'kya', 'haan', 'nahi', 'mujhe', 'karo', 'chahiye']);

function detectLanguage(text) {
  const raw = String(text || '');
  if (!raw.trim()) return 'en';
  for (const { lang, re } of SCRIPT_LANGUAGES) {
    if (re.test(raw)) {
      if (lang === 'ar') return URDU_MARKERS.test(raw) ? 'ur' : 'ar';
      if (lang === 'ru') return UKRAINIAN_MARKERS.test(raw) ? 'uk' : 'ru';
      return lang;
    }
  }
  const normalized = normalize(raw);
  const words = new Set(normalized.split(/\s+/).filter(Boolean));
  let best = { lang: 'en', score: 0 };
  for (const [lang, hints] of Object.entries(LATIN_HINTS)) {
    let score = 0;
    for (const hint of hints) {
      if (hint.includes(' ')) {
        if (normalized.includes(hint)) score += 1;
      } else if (words.has(hint)) {
        score += 1;
      }
    }
    if (score > best.score) best = { lang, score };
  }
  if (best.score >= 2) return best.lang;
  for (const word of words) {
    if (!STRONG_HINTS.has(word)) continue;
    if (HINGLISH_HINTS.has(word)) return 'hi-Latn';
    return Object.keys(LATIN_HINTS).find(lang => lang !== 'hi-Latn' && LATIN_HINTS[lang].includes(word)) || 'en';
  }
  return 'en';
}

const BOUND = '(?![\\p{L}\\p{N}])';

const COMMAND_PATTERNS = [
  {
    type: 'chat', intent: 'greeting',
    re: new RegExp(`^(?:hi|hello|hey|yo|sup|namaste|namaskar|namaskara|namaskaram|vanakkam|sat sri akal|assalamu alaikum|salaam|salam|hola|buenos dias|buenas tardes|bonjour|salut|hallo|guten tag|ola|oi|ciao|buongiorno|privet|zdravstvuyte|ni hao|nǐ hǎo|konnichiwa|annyeong|annyeonghaseyo|merhaba|selam|halo|hej|czesc|dzien dobry|xin chao|chao ban|kya haal|kaise ho|kaisa hai|नमस्ते|नमस्कार|नमस्कारम्|प्रणाम|привет|здравствуйте|хай|你好|您好|こんにちは|やあ|안녕|안녕하세요|مرحبا|مرحباً|السلام عليكم|أهلا|کیا حال ہے|হ্যালো|নমস্কার|வணக்கம்|నమస్కారం|ਸਤ ਸ੍ਰੀ ਅਕਾਲ)${BOUND}`, 'u')
  },
  {
    type: 'chat', intent: 'thanks',
    re: new RegExp(`^(?:thanks|thank you|thx|ty|dhanyavad|dhanyawad|shukriya|bahut dhanyavad|gracias|muchas gracias|merci|merci beaucoup|danke|danke schon|vielen dank|obrigado|obrigada|valeu|grazie|mille grazie|spasibo|blagodaryu|xie xie|xiè xie|arigatou|arigato|gomawo|kamsahamnida|tesekkurler|tesekkur ederim|terima kasih|makasih|dziekuje|dzieki|cam on|thanku|धन्यवाद|शुक्रिया|बहुत धन्यवाद|спасибо|благодарю|谢谢|谢谢你|ありがとう|どうも|고마워|감사합니다|شكرا|شکراً|شکریہ|ধন্যবাদ|நன்றி|ధన్యవాదాలు|ਧੰਨਵਾਦ)${BOUND}`, 'u')
  },
  {
    type: 'chat', intent: 'acknowledge',
    re: new RegExp(`^(?:ok|okay|okey|theek hai|thik hai|haan|ji haan|ji|vale|si|oui|ja|sim|हाँ|ठीक है|جی ہاں|ہاں)${BOUND}$`, 'u')
  },
  {
    type: 'stop',
    re: new RegExp(`^(?:stop|halt|ruk|ruko|ruk jao|bas|bas karo|band karo|chhodo|chodo|pare|alto|arrete|stop it|stoppen|para|pare de|fermati|stoy|stoi|ostanovites|ting zhi|tingzhi|yamete|meomchwo|dur|berhenti|dung lai|dung|रुको|रुक जाओ|बस|बस करो|बंद करो|остановись|стоп|停止|停下|やめて|止まれ|멈춰|توقف|رکو|بس|রুকো|থামো|நிறுத்து|ఆపు|ਰੁਕੋ)${BOUND}`, 'u')
  },
  {
    type: 'follow',
    re: new RegExp(`^(?:follow me|mere piche aao|mere peeche aao|mere pichhe aao|mera picha karo|sigueme|suis moi|suis-moi|folge mir|siga me|sigam-me|seguimi|idi za mnoy|gen wo lai|gen zhe wo|ttara wa|takip et|ikuti aku|ikutilah aku|di theo toi|chodz za mna|मेरे पीछे आओ|میرے پیچھے آؤ|跟着我|ついてきて|따라와|اتبعني)${BOUND}`, 'u')
  },
  {
    type: 'come',
    re: new RegExp(`(?:come here|come to me|aao|aaja|aa jao|idhar aao|yahan aao|mere paas aao|ven aqui|viens ici|viens|komm her|komm|vem ca|vem aqui|vieni qui|vieni|idi syuda|ko mne|lai|guo lai|lai zhe|iro|ire|gel|gel sini|gel buraya|den day|pade|chodz tu|chodz|आओ|आजा|इधर आओ|यहाँ आओ|یہاں آؤ|آؤ|来这里|过来|来|ここに来て|来て|이리 와|와|تعال|এসো|வா|రా)${BOUND}`, 'u')
  }
];

function parseMultilingualIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const normalized = normalize(raw);
  if (!normalized) return null;
  for (const pattern of COMMAND_PATTERNS) {
    if (pattern.re.test(normalized)) {
      const intent = { ...pattern, re: undefined, lang: detectLanguage(raw), raw };
      if (pattern.type === 'follow') {
        const duration = normalized.match(/\bfor\s+(\d{1,3})\s*(seconds?|secs?|minutes?|mins?)\b/);
        const requestedMs = duration
          ? Number(duration[1]) * (/^(?:m|min|mins|minute|minutes)$/i.test(duration[2]) ? 60000 : 1000)
          : 10 * 60 * 1000;
        intent.durationMs = Math.max(5000, Math.min(requestedMs, 10 * 60 * 1000));
      }
      return intent;
    }
  }
  return null;
}

const REPLIES = {
  en: {
    greeting: "Hello! I'm Virgo, your AI Minecraft companion. Ready to mine, craft, defend, build, or learn.",
    thanks: "You're welcome! Glad to help.",
    working: 'On it.',
    stillWorking: "I'm still working on the current task. Say stop if you want me to switch.",
    stopped: 'Stopped.',
    fallback: 'I am here at {pos} with {health}/20 health. Ask me anything.'
  },
  'hi-Latn': {
    greeting: 'Namaste! Main Virgo hoon, aapka AI Minecraft saathi. Batao kya karna hai.',
    thanks: 'Koi baat nahi! Khushi hui madad karke.',
    working: 'Theek hai, kar raha hoon.',
    stillWorking: 'Main abhi kaam kar raha hoon. Rokna ho to stop bolo.',
    stopped: 'Ruk gaya.',
    fallback: 'Main yahan {pos} par hoon, health {health}/20. Kuch bhi poocho.'
  },
  hi: {
    greeting: 'नमस्ते! मैं Virgo हूँ, आपका AI Minecraft साथी। बताइए क्या करना है।',
    thanks: 'कोई बात नहीं! मदद करके खुशी हुई।',
    working: 'ठीक है, कर रहा हूँ।',
    stillWorking: 'मैं अभी काम कर रहा हूँ। रोकना हो तो stop बोलिए।',
    stopped: 'रुक गया।',
    fallback: 'मैं यहाँ {pos} पर हूँ, health {health}/20। कुछ भी पूछिए।'
  },
  ur: {
    greeting: 'السلام علیکم! میں Virgo ہوں، آپ کا AI Minecraft ساتھی۔ بتائیں کیا کرنا ہے۔',
    thanks: 'کوئی بات نہیں! مدد کر کے خوشی ہوئی۔',
    working: 'ٹھیک ہے، کر رہا ہوں۔',
    stillWorking: 'میں ابھی کام کر رہا ہوں۔ روکنا ہو تو stop کہیں۔',
    stopped: 'رک گیا۔',
    fallback: 'میں یہاں {pos} پر ہوں، health {health}/20۔ کچھ بھی پوچھیں۔'
  },
  es: {
    greeting: '¡Hola! Soy Virgo, tu compañero de Minecraft. Dime qué necesitas.',
    thanks: '¡De nada! Encantado de ayudar.',
    working: 'Entendido, ya voy.',
    stillWorking: 'Todavía estoy trabajando en la tarea actual. Di stop para cambiar.',
    stopped: 'Detenido.',
    fallback: 'Estoy aquí en {pos} con {health}/20 de salud. Pregúntame lo que quieras.'
  },
  fr: {
    greeting: 'Salut ! Je suis Virgo, ton compagnon Minecraft. Dis-moi ce qu\'il faut faire.',
    thanks: 'De rien ! Content d\'aider.',
    working: 'Compris, je m\'en occupe.',
    stillWorking: 'Je travaille encore sur la tâche en cours. Dis stop pour changer.',
    stopped: 'Arrêté.',
    fallback: 'Je suis ici à {pos} avec {health}/20 de vie. Pose-moi une question.'
  },
  de: {
    greeting: 'Hallo! Ich bin Virgo, dein Minecraft-Begleiter. Sag mir, was zu tun ist.',
    thanks: 'Gern geschehen!',
    working: 'Verstanden, ich kümmere mich darum.',
    stillWorking: 'Ich arbeite noch an der aktuellen Aufgabe. Sag stop zum Wechseln.',
    stopped: 'Gestoppt.',
    fallback: 'Ich bin hier bei {pos} mit {health}/20 Leben. Frag mich irgendetwas.'
  },
  pt: {
    greeting: 'Olá! Sou o Virgo, seu companheiro de Minecraft. Diga o que precisa.',
    thanks: 'De nada! Feliz em ajudar.',
    working: 'Entendido, já vou.',
    stillWorking: 'Ainda estou trabalhando na tarefa atual. Diga stop para trocar.',
    stopped: 'Parado.',
    fallback: 'Estou aqui em {pos} com {health}/20 de vida. Pergunte o que quiser.'
  },
  it: {
    greeting: 'Ciao! Sono Virgo, il tuo compagno di Minecraft. Dimmi cosa serve.',
    thanks: 'Prego! Felice di aiutare.',
    working: 'Capito, ci penso io.',
    stillWorking: 'Sto ancora lavorando al compito attuale. Di stop per cambiare.',
    stopped: 'Fermato.',
    fallback: 'Sono qui a {pos} con {health}/20 di salute. Chiedimi qualsiasi cosa.'
  },
  nl: {
    greeting: 'Hallo! Ik ben Virgo, je Minecraft-metgezel. Zeg maar wat er moet gebeuren.',
    thanks: 'Graag gedaan!',
    working: 'Begrepen, ik doe het.',
    stillWorking: 'Ik werk nog aan de huidige taak. Zeg stop om te wisselen.',
    stopped: 'Gestopt.',
    fallback: 'Ik sta hier op {pos} met {health}/20 gezondheid. Vraag me alles.'
  },
  pl: {
    greeting: 'Cześć! Jestem Virgo, twój towarzysz w Minecraft. Powiedz, co trzeba zrobić.',
    thanks: 'Nie ma za co!',
    working: 'Rozumiem, zajmuję się tym.',
    stillWorking: 'Nadal pracuję nad zadaniem. Powiedz stop, aby zmienić.',
    stopped: 'Zatrzymano.',
    fallback: 'Jestem tutaj na {pos} z {health}/20 zdrowia. Pytaj o cokolwiek.'
  },
  tr: {
    greeting: 'Merhaba! Ben Virgo, Minecraft yol arkadaşın. Ne yapmam gerektiğini söyle.',
    thanks: 'Rica ederim!',
    working: 'Anladım, yapıyorum.',
    stillWorking: 'Şu anki görev üzerinde çalışıyorum. Değiştirmek için stop de.',
    stopped: 'Durdu.',
    fallback: '{pos} konumunda, {health}/20 canla buradayım. Her şeyi sorabilirsin.'
  },
  id: {
    greeting: 'Halo! Saya Virgo, teman Minecraft-mu. Bilang apa yang perlu dilakukan.',
    thanks: 'Sama-sama! Senang bisa membantu.',
    working: 'Baik, saya kerjakan.',
    stillWorking: 'Saya masih mengerjakan tugas saat ini. Bilang stop untuk ganti.',
    stopped: 'Berhenti.',
    fallback: 'Saya di {pos} dengan {health}/20 kesehatan. Tanya apa saja.'
  },
  vi: {
    greeting: 'Xin chào! Tôi là Virgo, bạn đồng hành Minecraft của bạn. Hãy nói cần làm gì.',
    thanks: 'Không có gì! Rất vui được giúp.',
    working: 'Hiểu rồi, tôi làm ngay.',
    stillWorking: 'Tôi vẫn đang làm nhiệm vụ hiện tại. Nói stop để đổi.',
    stopped: 'Đã dừng.',
    fallback: 'Tôi ở {pos} với {health}/20 máu. Hỏi tôi bất cứ điều gì.'
  },
  ru: {
    greeting: 'Привет! Я Virgo, твой спутник в Minecraft. Скажи, что нужно сделать.',
    thanks: 'Пожалуйста! Рад помочь.',
    working: 'Понял, уже делаю.',
    stillWorking: 'Я всё ещё работаю над задачей. Скажи stop, чтобы переключиться.',
    stopped: 'Остановлено.',
    fallback: 'Я здесь, {pos}, здоровье {health}/20. Спрашивай что угодно.'
  },
  uk: {
    greeting: 'Привіт! Я Virgo, твій супутник у Minecraft. Кажи, що треба зробити.',
    thanks: 'Нема за що! Радий допомогти.',
    working: 'Зрозумів, уже роблю.',
    stillWorking: 'Я ще працюю над завданням. Скажи stop, щоб змінити.',
    stopped: 'Зупинено.',
    fallback: 'Я тут, {pos}, здоров\'я {health}/20. Питай будь-що.'
  },
  zh: {
    greeting: '你好！我是 Virgo，你的 Minecraft 伙伴。告诉我需要做什么。',
    thanks: '不客气！很高兴帮忙。',
    working: '明白，现在去做。',
    stillWorking: '我还在处理当前任务。说 stop 可以切换。',
    stopped: '已停止。',
    fallback: '我在 {pos}，生命值 {health}/20。随便问我。'
  },
  ja: {
    greeting: 'こんにちは！Virgoです、あなたのMinecraft相棒。何をするか教えてください。',
    thanks: 'どういたしまして！お役に立てて嬉しいです。',
    working: '了解、やります。',
    stillWorking: '今のタスクをまだ実行中です。切り替えるには stop と言ってください。',
    stopped: '停止しました。',
    fallback: '{pos} にいて、体力は {health}/20 です。何でも聞いてください。'
  },
  ko: {
    greeting: '안녕하세요! 저는 Virgo, 당신의 Minecraft 동료입니다. 무엇을 할지 말해주세요.',
    thanks: '천만에요! 도와드려 기쁩니다.',
    working: '알겠습니다, 바로 할게요.',
    stillWorking: '아직 현재 작업 중입니다. 바꾸려면 stop이라고 말하세요.',
    stopped: '멈췄습니다.',
    fallback: '{pos}에 있고 체력은 {health}/20입니다. 무엇이든 물어보세요.'
  },
  ar: {
    greeting: 'مرحباً! أنا Virgo، رفيقك في Minecraft. قل لي ما تريد فعله.',
    thanks: 'عفواً! سعيد بالمساعدة.',
    working: 'فهمت، سأفعل ذلك.',
    stillWorking: 'ما زلت أعمل على المهمة الحالية. قل stop للتغيير.',
    stopped: 'توقف.',
    fallback: 'أنا هنا في {pos} بصحة {health}/20. اسألني أي شيء.'
  },
  bn: {
    greeting: 'হ্যালো! আমি Virgo, আপনার Minecraft সঙ্গী। কী করতে হবে বলুন।',
    thanks: 'আপনাকে স্বাগতম! সাহায্য করতে পেরে খুশি।',
    working: 'বুঝেছি, করছি।',
    stillWorking: 'আমি এখনও কাজ করছি। বদলাতে stop বলুন।',
    stopped: 'থামানো হয়েছে।',
    fallback: 'আমি এখানে {pos} এ আছি, স্বাস্থ্য {health}/20। যা কিছু জিজ্ঞাসা করুন।'
  },
  ta: {
    greeting: 'வணக்கம்! நான் Virgo, உங்கள் Minecraft துணை. என்ன செய்ய வேண்டும் சொல்லுங்கள்.',
    thanks: 'பரவாயில்லை! உதவ மகிழ்ச்சி.',
    working: 'புரிந்தது, செய்கிறேன்.',
    stillWorking: 'நான் இன்னும் வேலையில் இருக்கிறேன். மாற stop சொல்லுங்கள்.',
    stopped: 'நிறுத்தப்பட்டது.',
    fallback: 'நான் {pos} இல் இருக்கிறேன், உடல்நலம் {health}/20. எதையும் கேளுங்கள்.'
  },
  te: {
    greeting: 'హలో! నేను Virgo, మీ Minecraft తోడు. ఏం చేయాలో చెప్పండి.',
    thanks: 'పర్వాలేదు! సహాయం చేయడం సంతోషం.',
    working: 'అర్థమైంది, చేస్తున్నాను.',
    stillWorking: 'నేను ఇంకా పని చేస్తున్నాను. మారాలంటే stop చెప్పండి.',
    stopped: 'ఆపబడింది.',
    fallback: 'నేను {pos} లో ఉన్నాను, ఆరోగ్యం {health}/20. ఏదైనా అడగండి.'
  },
  pa: {
    greeting: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ Virgo ਹਾਂ, ਤੁਹਾਡਾ Minecraft ਸਾਥੀ। ਦੱਸੋ ਕੀ ਕਰਨਾ ਹੈ।',
    thanks: 'ਕੋਈ ਗੱਲ ਨਹੀਂ! ਮਦਦ ਕਰਕੇ ਖੁਸ਼ੀ ਹੋਈ।',
    working: 'ਠੀਕ ਹੈ, ਕਰ ਰਿਹਾ ਹਾਂ।',
    stillWorking: 'ਮੈਂ ਹਾਲੇ ਕੰਮ ਕਰ ਰਿਹਾ ਹਾਂ। ਬਦਲਣ ਲਈ stop ਕਹੋ।',
    stopped: 'ਰੁਕ ਗਿਆ।',
    fallback: 'ਮੈਂ ਇੱਥੇ {pos} ਤੇ ਹਾਂ, ਸਿਹਤ {health}/20। ਕੁਝ ਵੀ ਪੁੱਛੋ।'
  },
  mr: {
    greeting: 'नमस्कार! मी Virgo आहे, तुमचा Minecraft सोबती. काय करायचं ते सांगा.',
    thanks: 'काही हरकत नाही! मदत करून आनंद झाला.',
    working: 'ठीक आहे, करतो.',
    stillWorking: 'मी अजून काम करत आहे. बदलायचं असेल तर stop म्हणा.',
    stopped: 'थांबवलं.',
    fallback: 'मी इथे {pos} वर आहे, आरोग्य {health}/20. काहीही विचारा.'
  }
};

function languageName(lang) {
  const names = {
    en: 'English', 'hi-Latn': 'Hinglish', hi: 'Hindi', ur: 'Urdu', bn: 'Bengali',
    ta: 'Tamil', te: 'Telugu', pa: 'Punjabi', mr: 'Marathi', es: 'Spanish',
    fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch',
    pl: 'Polish', tr: 'Turkish', id: 'Indonesian', vi: 'Vietnamese', ru: 'Russian',
    uk: 'Ukrainian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic'
  };
  return names[lang] || lang;
}

function reply(kind, lang, data = {}) {
  const table = REPLIES[lang] || REPLIES.en;
  const template = table[kind] || REPLIES.en[kind] || '';
  return template
    .replace(/\{pos\}/g, data.pos || 'ready')
    .replace(/\{health\}/g, String(data.health ?? 20));
}

module.exports = {
  detectLanguage,
  languageName,
  parseMultilingualIntent,
  reply,
  normalize,
  supportedLanguages: Object.keys(REPLIES)
};
