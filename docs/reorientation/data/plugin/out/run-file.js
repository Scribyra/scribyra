async (page)=>({title:await page.title(),hasScribyra:await page.evaluate(()=>typeof window.scribyra)})
