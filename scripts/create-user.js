// Adds a portal user. Usage: npm run create-user -- <username> <password> [display name]
const { pool } = require('../src/db');
const { validateUsername, validatePassword, hashPassword } = require('../src/lib/users');

async function main() {
  const [username = '', password = '', ...nameParts] = process.argv.slice(2);
  const displayName = nameParts.join(' ').trim().slice(0, 100) || null;
  if (!username || !password) {
    console.error('Usage: npm run create-user -- <username> <password> [display name]');
    process.exitCode = 1;
    return;
  }

  const problem = validateUsername(username) || validatePassword(password);
  if (problem) {
    console.error(problem);
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);
  try {
    await pool.query('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)', [username, displayName, hash, 'admin']);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      console.error(`User "${username}" already exists.`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log(`User "${username}" created.`);
}

main()
  .catch((err) => {
    console.error('Could not create user:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
