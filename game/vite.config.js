// base './': the build works from any sub-path (GitHub Pages serves it at /<repo>/); asset URLs in the code are relative
export default { base: './', server: { port: 5299, strictPort: true, host: '127.0.0.1' } };
