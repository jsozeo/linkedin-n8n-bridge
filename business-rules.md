For all action, they should be pushed to a queue (supabase table).As the system is asynchrone (every minutes it polls a job), then we should be careful to remove a job after it has been sent to linkedin
analysing (brain) actions should be made every 30 sec this cron should be triggered inside n8n directly
scraping actions list should be updated in real time, but by specifying a proper priority


Webflow strategy on linkedin post
1 - scrap posts https://www.linkedin.com/search/results/content/?keywords="webflow"&origin=FACETED_SEARCH&sortBy=%5B%22date_posted%22%5D&datePosted=%5B%22past-24h%22%5D every 1h with a priority 5, stop when a known post id is scraped
1.1 qualify each post :
- need identitied go to 1.1.1 
- no need, but honeypot (business perspective where business owner can identity and openly show their interest) go to 1.1.2 
- no need, competitor - stop (1.1.3)
1.1.1 scrap profile (priority 3), company (priority 2), write sequence
1.1.2 wait 3 days, scrap comments of current post, spawn each comment with profile (priority 4), analyse with llm if comment show interest : 
- if yes, go to 1.1.2.1
- if no, stop (1.1.2.2)
1.1.2.1 : scrap profile (priority 3), company (priority 2), write sequence, (different than 1.1.1) 
NB, the cron performs a get every minutes, but, we need to protect the session, never scrap every minutes, put some protections :
- never scrap in less than 1 hour the posts
- never scrap twice a profile, company, comments of a same post in same day
with 2 actions in the queue, always start with lowest priority

This strategy can be replicated for keywords wordpress, framer, hubspot cms

Webflow job strategy for EMEA
1 - scrap jobs of https://www.linkedin.com/jobs/search/?currentJobId=4438025078&f_TPR=r86400&geoId=91000007&keywords=%22webflow%22&origin=JOB_SEARCH_PAGE_JOB_FILTER&refresh=true for EMEA 
send a list of job url, 
1.1 perform a get single job,
1.1.1 analyse the job description, and with llm find any decision makers mentioned in description
1.1.1.1 if decision makers are defined explicitely, perform a direct search with search people
1.1.1.2 if decision makers are defined implicitely, find people company using keyword or facetedsearch, but this step should be defined by a llm as interpretation is needed
1.1.1.2.1 when people are identified, then scrap profile (with priority 3), then define if they are suitable for being reached out via llm if 
- yes go to 1.1.1.2.1.1
- no, stop (1.1.1.2.1.2)
1.1.1.2.1.1 : write a sequence, enrich and send it to instantly
NB this strategy for EMEA can be extended to USA with url  https://www.linkedin.com/jobs/search/?currentJobId=4404375061&f_TPR=r86400&geoId=103644278&keywords=%22webflow%22&origin=JOB_SEARCH_PAGE_LOCATION_AUTOCOMPLETE&refresh=true 
Never scrap more than once per day for each job url


in N8N I don't like supabase nodes, I prefer postgres nodes, 
For each step, I need to have a rectangle with a description of the step with the various nodes inside