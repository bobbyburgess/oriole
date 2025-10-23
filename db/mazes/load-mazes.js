// Load maze JSON files into Postgres database

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

async function loadMazes() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    await client.connect();
    console.log('Connected to database\n');

    // Get all maze JSON files
    const files = fs.readdirSync(__dirname)
      .filter(f => f.endsWith('.json'))
      .sort();

    console.log(`Found ${files.length} maze files\n`);

    for (const file of files) {
      const filePath = path.join(__dirname, file);
      const maze = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Insert maze into database
      const query = `
        INSERT INTO mazes (name, width, height, grid_data, see_through_walls)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
        RETURNING id
      `;

      const values = [
        maze.name,
        maze.width,
        maze.height,
        JSON.stringify(maze.grid_data),
        maze.see_through_walls
      ];

      const result = await client.query(query, values);
      if (result.rows.length > 0) {
        console.log(`✅ Loaded: ${maze.name} (ID: ${result.rows[0].id})`);
      } else {
        console.log(`⏭️  Skipped: ${maze.name} (already exists)`);
      }
    }

    // Show summary
    const countResult = await client.query('SELECT COUNT(*) FROM mazes');
    console.log(`\n📊 Total mazes in database: ${countResult.rows[0].count}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

loadMazes();
