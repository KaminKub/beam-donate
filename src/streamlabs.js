const axios = require('axios');

/**
 * Streamlabs API Wrapper
 * This service provides helper methods to interact with the Streamlabs API
 * using a streamer's stored access token.
 */
class StreamlabsService {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.api = axios.create({
      baseURL: 'https://streamlabs.com/api/v2.0',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/json'
      }
    });
  }

  /**
   * Get the authenticated user's profile information.
   */
  async getUser() {
    try {
      const response = await this.api.get('/user');
      return response.data;
    } catch (error) {
      console.error('❌ Streamlabs API Error (getUser):', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Example: Get recent donations/tips.
   * Implementation depends on specific Streamlabs API endpoints for the account type.
   */
  async getRecentDonations(limit = 20) {
    try {
      const response = await this.api.get('/donations', {
        params: { limit }
      });
      return response.data;
    } catch (error) {
      console.error('❌ Streamlabs API Error (getRecentDonations):', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = (accessToken) => new StreamlabsService(accessToken);
