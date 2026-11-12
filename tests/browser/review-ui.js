export async function openReview(page){
 const toggle=page.getByRole('button',{name:'Review',exact:true});
 if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
}
export async function openReviewMenu(page){
 await openReview(page);const toggle=page.getByRole('button',{name:'Review actions',exact:true});
 if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
}
export async function openComments(page){
 await openReview(page);const toggle=page.locator('#review-workspace').getByRole('button',{name:'Review tools',exact:true,includeHidden:true});
 if(await toggle.getAttribute('aria-expanded')==='false'){await openReviewMenu(page);await toggle.click();}
}
export async function openReviews(page){
 await openComments(page);
 if(!await page.locator('.reviews-panel').evaluate(panel=>panel.open))await page.getByText('Reviews and proposed changes',{exact:true}).click();
}
