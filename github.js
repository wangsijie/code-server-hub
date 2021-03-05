const axios = require('axios');

const CLIENT_ID = process.env.GH_CLIENT_ID;
const CLIENT_SECRET = process.env.GH_CLIENT_SECRET;
const GITHUB_BASE_URL = process.env.GH_BASE_URL || 'https://github.com';
const GITHUB_API_URL = process.env.GH_API_URL || 'https://api.github.com' ;

if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('missing GH_CLIENT_ID or GH_CLIENT_SECRET');
}

module.exports.requestAccessToken = async (code) => {
    const res = await axios.post(
        `${GITHUB_BASE_URL}/login/oauth/access_token`,
        {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
        },
        {
            headers: {
                accept: 'application/json',
            }
        },
    );
    return res.data;
}

module.exports.getUserInfo = async (token) => {
    const res = await axios.get(`${GITHUB_API_URL}/user`, { headers: { authorization: `bearer ${token}` } });
    return res.data;
}
