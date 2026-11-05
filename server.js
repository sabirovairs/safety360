require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Подключение к базе данных (берет URL из настроек Render)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Обязательно для Neon и Render
});

const translitMap = { 'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya','А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'E','Ж':'Zh','З':'Z','И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Sch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya' };
function translit(str) { return str.split('').map(c => translitMap[c] !== undefined ? translitMap[c] : c).join(''); }

// ==================== АВТОРИЗАЦИЯ ====================
app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;
    try {
        const result = await pool.query('SELECT id, login, fio, role, position, avatar, site_access, dept_access FROM users WHERE login = $1 AND password = $2', [login, password]);
        if (result.rows.length > 0) res.json({ success: true, user: result.rows[0] });
        else res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ success: false, message: 'Ошибка сервера' }); 
    }
});

// ==================== ПОЛЬЗОВАТЕЛИ ====================
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, login, fio, position, role, site_access, dept_access, is_registered FROM users ORDER BY fio');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Ошибка удаления' }); }
});

app.post('/api/register', async (req, res) => {
    const { fio, position, site, dept } = req.body;
    const parts = fio.trim().split(/\s+/);
    const surname = translit(parts[0] || 'User');
    const nameInitial = parts[1] ? translit(parts[1][0]).toUpperCase() : '';
    const patronymicInitial = parts[2] ? translit(parts[2][0]).toUpperCase() : '';
    const baseLogin = surname + nameInitial + patronymicInitial;
    let login = baseLogin, counter = 0;
    while (true) {
        const check = await pool.query('SELECT id FROM users WHERE login = $1', [login]);
        if (check.rows.length === 0) break;
        counter++; login = baseLogin + counter;
    }
    const password = Math.random().toString(36).slice(-8);
    const role = 'worker';
    const avatar = (parts[1] ? parts[1][0] : '') + (parts[2] ? parts[2][0] : '');
    try {
        const result = await pool.query(`INSERT INTO users (login, password, fio, role, position, avatar, site_access, dept_access, is_registered) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING login, password`, [login, password, fio, role, position, avatar, site, dept]);
        res.json({ success: true, login: result.rows[0].login, password: result.rows[0].password });
    } catch (err) { res.status(500).json({ error: 'Ошибка регистрации' }); }
});

// ==================== НАРУШЕНИЯ ====================
app.get('/api/violations', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM violations ORDER BY check_date DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/violations', async (req, res) => {
    const { desc, site, dept, object_name, section, responsible, due, checkDate, masterName, photo_url } = req.body;
    try {
        // Сохраняем фото (Base64) прямо в базу данных
        const result = await pool.query(
            `INSERT INTO violations (desc_text, site, dept, object_name, section, responsible, due, check_date, status, master_name, photo_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10) RETURNING *`,
            [desc, site, dept, object_name, section, responsible, due, checkDate, masterName, photo_url || null]
        );
        const newViolation = result.rows[0];
        if (responsible) {
            const surname = responsible.trim().split(/\s+/)[0];
            const userSearch = await pool.query(`SELECT fio FROM users WHERE fio LIKE $1 LIMIT 1`, [surname + '%']);
            const targetFio = userSearch.rows.length > 0 ? userSearch.rows[0].fio : responsible;
            await pool.query(`INSERT INTO notifications (user_fio, violation_id, message) VALUES ($1, $2, $3)`, [targetFio, newViolation.id, `Вам назначено нарушение: ${desc}`]);
        }
        res.json({ success: true, violation: newViolation });
    } catch (err) { 
        console.error("Ошибка сохранения:", err);
        res.status(500).json({ error: 'Ошибка при сохранении' }); 
    }
});

app.put('/api/violations/:id/close', async (req, res) => {
    const { id } = req.params;
    const { resolveComment, resolvePhoto } = req.body;
    try {
        await pool.query("UPDATE violations SET status = 'closed', closed_date = CURRENT_DATE, resolve_comment = $1, resolve_photo_url = $2 WHERE id = $3", [resolveComment, resolvePhoto, id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ПРОВЕРКИ ====================
app.get('/api/checks', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM checks ORDER BY check_date DESC'); res.json(result.rows); } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/checks', async (req, res) => {
    const { date, time, site, dept, object_name, master, note } = req.body;
    try {
        const result = await pool.query('INSERT INTO checks (check_date, check_time, site, dept, object_name, master, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [date, time, site, dept, object_name, master, note]);
        res.json({ success: true, check: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== УВЕДОМЛЕНИЯ ====================
app.get('/api/notifications/:fio', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM notifications WHERE user_fio = $1 ORDER BY created_at DESC', [req.params.fio]); res.json(result.rows); } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/notifications/:id/read', async (req, res) => {
    try { await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ФРОНТЕНД ====================
app.use((req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(port, () => console.log(`Backend running on port ${port}`));