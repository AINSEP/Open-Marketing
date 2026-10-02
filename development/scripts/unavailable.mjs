/** j23 owns packaging and production launch. These commands deliberately fail. */
console.error(JSON.stringify({ ok: false, error: { code: 'not_implemented', message: `om:${process.argv[2]} requires j23 packaging/deployment integration` } }));
process.exitCode = 1;
